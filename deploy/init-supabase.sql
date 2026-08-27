-- ЭТОТ ФАЙЛ СОБРАН. НЕ ПРАВЬТЕ ЕГО РУКАМИ.
--
-- Источник — supabase/migrations. Правка здесь потеряется при следующей сборке, а до тех пор
-- будет расходиться с боевой базой молча: оба файла выглядят рабочими.
--
--   изменить схему:  создать миграцию в supabase/migrations
--   пересобрать:     node deploy/build-init-sql.mjs
--   применить:       supabase db push   (предпочтительно — умеет докатывать)
--
-- Этот файл нужен для ОДНОГО случая: поднять схему на чистом проекте вставкой в SQL-редактор,
-- когда CLI недоступен. Для существующего проекта используйте db push: повторный прогон всего
-- файла целиком безопаснее не стал — часть миграций не идемпотентна.
--
-- Собрано из 165 миграций: 20260624090000_init.sql … 20260827100000_forge_event_bridge.sql

begin;
-- ЛИЧНЫЕ АДРЕСА ЗАМЕНЕНЫ НА redacted@invalid.
--
-- В истории миграций есть разовые «сделать администратором вот этот e-mail». На чистой базе они
-- задевают ноль строк, а адрес владельца исходной установки в вашей базе не нужен. Первая админка
-- выдаётся так: зарегистрируйтесь, подтвердите почту, затем от роли, которой прогонялись миграции
-- (в Supabase это postgres), выполните
--     select * from public.claim_platform_admin('<uuid пользователя>');
-- ─── 20260624090000_init.sql ─────────────────────────────────────────────────────────────────
-- Nemo AI — initial schema (NEMO_AI_SPEC §7). Postgres + Row-Level Security.
-- Edge Functions use the service_role key and bypass RLS; the frontend (anon /
-- authenticated) is scoped per account by the policies below.

create extension if not exists pgcrypto;

-- ---------- tables ----------
create table public.accounts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null default 'Nemo account',
  plan          text not null default 'beta',
  token_balance bigint not null default 100000,
  created_at    timestamptz not null default now()
);

create table public.users (
  id         uuid primary key references auth.users(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  email      text,
  role       text not null default 'owner',     -- owner | operator
  language   text not null default 'uz',
  created_at timestamptz not null default now()
);

create table public.agents (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  name         text not null,
  avatar       text,
  prompt       jsonb not null default '{"role":"","tasks":"","tone":"","rules":""}',
  model        text not null default 'openai/gpt-4o-mini',   -- OpenRouter model id
  temperature  numeric not null default 0.6,
  timezone     text not null default 'Asia/Tashkent',
  schedule     text not null default '24/7',
  default_lang text not null default 'auto',    -- auto | uz | ru
  status       text not null default 'active',  -- active | paused | draft
  created_at   timestamptz not null default now()
);

create table public.channels (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid not null references public.agents(id) on delete cascade,
  type         text not null,                   -- telegram | whatsapp | instagram | widget
  credentials  jsonb not null default '{}',     -- { bot_token, username, ... } (server-only)
  secret_token text,                            -- Telegram webhook secret
  status       text not null default 'connected',
  created_at   timestamptz not null default now()
);

create table public.dialogues (
  id               uuid primary key default gen_random_uuid(),
  agent_id         uuid not null references public.agents(id) on delete cascade,
  channel_id       uuid references public.channels(id) on delete set null,
  channel          text not null,
  external_id      text,                         -- telegram chat id
  customer_name    text,
  customer_contact text,
  status           text not null default 'open', -- open | resolved | needs_operator | error
  tags             text[] not null default '{}',
  operator_takeover boolean not null default false,
  operator_id      uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (channel_id, external_id)
);

create table public.messages (
  id          uuid primary key default gen_random_uuid(),
  dialogue_id uuid not null references public.dialogues(id) on delete cascade,
  author      text not null check (author in ('customer','agent','operator')),
  content     text not null default '',
  media_url   text,
  created_at  timestamptz not null default now()
);

create table public.leads (
  id            uuid primary key default gen_random_uuid(),
  dialogue_id   uuid references public.dialogues(id) on delete cascade,
  fields        jsonb not null default '{}',
  status        text not null default 'new',
  pushed_to_crm boolean not null default false,
  created_at    timestamptz not null default now()
);

create table public.knowledge_docs (
  id         uuid primary key default gen_random_uuid(),
  owner_type text not null default 'agent',     -- account | agent
  owner_id   uuid not null,
  source     text not null default 'faq',       -- file | faq | link
  name       text,
  content    text,                              -- naive RAG: raw text injected into prompt
  status     text not null default 'indexed',
  created_at timestamptz not null default now()
);

create table public.usage (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade,
  tokens     bigint not null default 0,
  cost       numeric not null default 0,
  model      text,
  created_at timestamptz not null default now()
);

create index on public.dialogues (channel_id, external_id);
create index on public.messages (dialogue_id, created_at);
create index on public.knowledge_docs (owner_id);

-- ---------- helpers ----------
create or replace function public.current_account_id()
returns uuid language sql stable security definer set search_path = public as $$
  select account_id from public.users where id = auth.uid()
$$;

-- new auth signup -> auto-provision an account + user row
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_account uuid;
begin
  insert into public.accounts (name) values (coalesce(new.email, 'Nemo')) returning id into new_account;
  insert into public.users (id, account_id, email) values (new.id, new_account, new.email);
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- updated_at touch on dialogues
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
create trigger dialogues_touch before update on public.dialogues
  for each row execute function public.touch_updated_at();

-- ---------- RLS ----------
alter table public.accounts       enable row level security;
alter table public.users          enable row level security;
alter table public.agents         enable row level security;
alter table public.channels       enable row level security;
alter table public.dialogues      enable row level security;
alter table public.messages       enable row level security;
alter table public.leads          enable row level security;
alter table public.knowledge_docs enable row level security;
alter table public.usage          enable row level security;

create policy acc_self    on public.accounts  for select using (id = public.current_account_id());
create policy usr_self    on public.users     for select using (account_id = public.current_account_id());
create policy agents_acc  on public.agents    for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
create policy channels_acc on public.channels for all
  using (agent_id in (select id from public.agents where account_id = public.current_account_id()))
  with check (agent_id in (select id from public.agents where account_id = public.current_account_id()));
create policy dialogues_acc on public.dialogues for all
  using (agent_id in (select id from public.agents where account_id = public.current_account_id()))
  with check (agent_id in (select id from public.agents where account_id = public.current_account_id()));
create policy messages_acc on public.messages for all
  using (dialogue_id in (select id from public.dialogues
         where agent_id in (select id from public.agents where account_id = public.current_account_id())))
  with check (true);
create policy leads_acc on public.leads for all
  using (dialogue_id in (select id from public.dialogues
         where agent_id in (select id from public.agents where account_id = public.current_account_id())))
  with check (true);
create policy knowledge_acc on public.knowledge_docs for all
  using (owner_id in (select id from public.agents where account_id = public.current_account_id()))
  with check (owner_id in (select id from public.agents where account_id = public.current_account_id()));
create policy usage_acc on public.usage for select using (account_id = public.current_account_id());

-- ---------- realtime (live dialogues / messages in the panel) ----------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.dialogues;

-- ─── 20260624120000_agent_ui_fields.sql ──────────────────────────────────────────────────────
-- UI fields the frontend agent editor needs that aren't in the base §7 schema.
alter table public.agents add column if not exists avatar_color text not null default 'violet';
alter table public.agents add column if not exists lead_form jsonb not null default '{}'::jsonb;

-- ─── 20260624150000_review_fixes.sql ─────────────────────────────────────────────────────────
-- Phase 1–2b review fixes (security + correctness).

-- 1) Close the RLS write hole: WITH CHECK must enforce the same ownership as USING,
--    otherwise an authenticated user could INSERT rows into other accounts' dialogues.
drop policy if exists messages_acc on public.messages;
create policy messages_acc on public.messages for all
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  )
  with check (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

drop policy if exists leads_acc on public.leads;
create policy leads_acc on public.leads for all
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  )
  with check (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

-- 2) Never expose channel secrets to the browser roles. Row access is still allowed
--    by RLS, but credentials/secret_token are unreadable by anon/authenticated.
--    NOTE: a column-level REVOKE is a no-op while the role holds a table-level SELECT
--    grant (Supabase grants one by default), so we revoke the table grant and re-grant
--    SELECT only on the safe columns. Edge Functions use service_role (bypasses this).
revoke select on public.channels from anon, authenticated;
grant select (id, agent_id, type, status, created_at) on public.channels to anon, authenticated;

-- 4) Cost guard: atomic token-balance decrement.
create or replace function public.decrement_token_balance(p_account uuid, p_amount bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounts
  set token_balance = greatest(0, token_balance - p_amount)
  where id = p_account;
$$;

-- ─── 20260624170000_agent_account_default.sql ────────────────────────────────────────────────
-- Fix: onboarding inserts an agent before the app shell hydrates account_id,
-- so the frontend would omit account_id and hit the NOT NULL constraint.
-- Give the column a server-side default that resolves the caller's account
-- from their JWT. RLS with-check still enforces it equals current_account_id().
alter table public.agents
  alter column account_id set default public.current_account_id();

-- Idempotent safety: UI fields used by the editor (added in an earlier migration).
alter table public.agents add column if not exists avatar_color text default 'violet';
alter table public.agents add column if not exists lead_form jsonb not null default '{}';

-- Server-only store for customer-provided LLM provider API keys (BYO key).
-- The client may INSERT/UPDATE its own account's keys but can never SELECT them
-- back; Edge Functions read them via service_role. Keeps secrets off the client.
create table if not exists public.provider_keys (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  provider   text not null,                 -- openai | anthropic | google | ...
  api_key    text not null,
  created_at timestamptz not null default now(),
  unique (account_id, provider)
);

alter table public.provider_keys enable row level security;

-- write-only from the client: insert/update/delete own rows, but NO select policy
drop policy if exists provider_keys_write on public.provider_keys;
create policy provider_keys_write on public.provider_keys for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

-- the client must never read raw keys back
revoke select on public.provider_keys from anon, authenticated;
-- but it needs to know WHICH providers have a key (to show "connected" state)
grant select (provider, created_at) on public.provider_keys to authenticated;

-- ─── 20260624180000_research_runs.sql ────────────────────────────────────────────────────────
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

-- ─── 20260625120000_admin_tokens.sql ─────────────────────────────────────────────────────────
-- Platform admin + token economy (grants, gift codes, balance limits).

-- 1) platform admin flag on users
alter table public.users add column if not exists is_admin boolean not null default false;

-- bootstrap: promote the owner email if it already registered
update public.users set is_admin = true where email = 'redacted@invalid';

-- auto-promote that email on future signups (re-declare the trigger fn)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare new_account uuid;
begin
  insert into public.accounts (name) values (coalesce(new.email, 'Nemo')) returning id into new_account;
  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, coalesce(new.email, '') = 'redacted@invalid');
  return new;
end; $$;

-- 2) admin balance helpers (SECURITY DEFINER — called by edge fns via service_role)
create or replace function public.add_token_balance(p_account uuid, p_amount bigint)
returns bigint language sql security definer set search_path = public as $$
  update public.accounts set token_balance = token_balance + p_amount where id = p_account
  returning token_balance;
$$;

create or replace function public.set_token_balance(p_account uuid, p_amount bigint)
returns bigint language sql security definer set search_path = public as $$
  update public.accounts set token_balance = greatest(p_amount, 0) where id = p_account
  returning token_balance;
$$;

-- 3) gift codes
create table if not exists public.gift_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  tokens      bigint not null,
  created_by  uuid,
  redeemed_by uuid,
  redeemed_at timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.gift_codes enable row level security;
-- No client policies: only Edge Functions (service_role) touch this table.

-- ─── 20260626120000_phase2_step1.sql ─────────────────────────────────────────────────────────
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

-- ─── 20260627100000_security_token_rpc.sql ───────────────────────────────────────────────────
-- Security hardening (vibe-security audit).
--
-- CRITICAL FIX — privilege escalation via PostgREST RPC.
-- add_token_balance / set_token_balance / decrement_token_balance are
-- SECURITY DEFINER (they bypass RLS to update accounts.token_balance) and were
-- EXECUTE-able by anon + authenticated. Any logged-in user could mint themselves
-- unlimited tokens, e.g.:
--   supabase.rpc('add_token_balance', { p_account: <own account>, p_amount: 1e12 })
-- draining the shared OpenRouter pool / bypassing billing entirely.
--
-- These helpers are only ever called by Edge Functions (service_role). Restrict
-- EXECUTE to service_role so the client (anon/authenticated) cannot call them.
revoke execute on function public.add_token_balance(uuid, bigint)       from public, anon, authenticated;
revoke execute on function public.set_token_balance(uuid, bigint)       from public, anon, authenticated;
revoke execute on function public.decrement_token_balance(uuid, bigint) from public, anon, authenticated;

grant execute on function public.add_token_balance(uuid, bigint)       to service_role;
grant execute on function public.set_token_balance(uuid, bigint)       to service_role;
grant execute on function public.decrement_token_balance(uuid, bigint) to service_role;

-- ─── 20260627140000_credits_economy.sql ──────────────────────────────────────────────────────
-- Economics v2 — token balance is now in CREDITS.
-- 1 credit = 1000 LLM tokens of usage; $1 = 250 credits. New accounts start with 1000.
--
-- Edge Functions still pass RAW LLM token counts to decrement_token_balance; this
-- redefinition converts them to credits (ceil(llm/1000)) so NO function code changes.

create or replace function public.decrement_token_balance(p_account uuid, p_amount bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounts
  set token_balance = greatest(0, token_balance - ceil(p_amount / 1000.0)::bigint)
  where id = p_account;
$$;

-- one-time: convert existing balances from raw LLM tokens to credits
update public.accounts set token_balance = ceil(token_balance / 1000.0)::bigint;

-- new accounts start with 1000 credits (was 100000 raw tokens)
alter table public.accounts alter column token_balance set default 1000;

-- keep the security hardening: only service_role (Edge Functions) may charge the balance
revoke execute on function public.decrement_token_balance(uuid, bigint) from public, anon, authenticated;
grant  execute on function public.decrement_token_balance(uuid, bigint) to service_role;

-- ─── 20260627150000_agent_work_hours.sql ─────────────────────────────────────────────────────
-- Custom work hours: when schedule = 'work-hours', the agent is active only
-- between work_start and work_end (HH:MM, in the agent's timezone). 24/7 = always.
alter table public.agents add column if not exists work_start text;
alter table public.agents add column if not exists work_end   text;

-- ─── 20260627160000_account_blocked.sql ──────────────────────────────────────────────────────
-- Admin moderation: an account can be blocked (soft — can log in but can't use
-- the platform; its agents are paused). Hard ban (cannot log in) is done via the
-- GoTrue admin API (auth.users ban_duration) from the admin-api function.
alter table public.accounts add column if not exists blocked boolean not null default false;

-- ─── 20260628120000_agent_voice.sql ──────────────────────────────────────────────────────────
-- Voice (TTS/STT) per agent — config only for now; synthesis activates when a
-- voice provider key is connected. Voice selection is chosen by the user.
alter table public.agents add column if not exists voice_enabled boolean not null default false;
alter table public.agents add column if not exists voice_mode    text;   -- tts | stt | both
alter table public.agents add column if not exists voice_id      text;   -- selected voice

-- ─── 20260628140000_referrals.sql ────────────────────────────────────────────────────────────
-- Referral program: each account has a referral_code; signing up with a friend's
-- code credits BOTH sides a bonus. "Пригласи друга — получи токены."

alter table public.accounts add column if not exists referral_code text;
alter table public.accounts add column if not exists referred_by  uuid references public.accounts(id) on delete set null;

create unique index if not exists accounts_referral_code_idx on public.accounts (referral_code) where referral_code is not null;

-- backfill codes for existing accounts
update public.accounts
set referral_code = upper(substr(md5(id::text || random()::text), 1, 8))
where referral_code is null;

-- signup hook: create account (with a referral code) + user, and apply the
-- referral bonus when the new user signed up with a valid ref code (in metadata).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_account uuid;
  ref_code text;
  ref_acc uuid;
  bonus bigint := 200;  -- credits granted to each side on a successful referral
begin
  ref_code := upper(coalesce(new.raw_user_meta_data->>'ref', ''));
  insert into public.accounts (name, referral_code)
  values (coalesce(new.email, 'Nemo'), upper(substr(md5(new.id::text || random()::text), 1, 8)))
  returning id into new_account;
  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, coalesce(new.email, '') = 'redacted@invalid');

  if ref_code <> '' then
    select id into ref_acc from public.accounts where referral_code = ref_code and id <> new_account limit 1;
    if ref_acc is not null then
      update public.accounts set referred_by = ref_acc where id = new_account;
      update public.accounts set token_balance = token_balance + bonus where id = ref_acc;
      update public.accounts set token_balance = token_balance + bonus where id = new_account;
    end if;
  end if;
  return new;
end; $$;

-- ─── 20260629000000_multi_agent_migration.sql ────────────────────────────────────────────────
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

-- ─── 20260702120000_security_hardening.sql ───────────────────────────────────────────────────
-- Security hardening (2026-07-02 audit). Defense-in-depth over the existing,
-- already-solid account-scoped RLS. Safe to run once against prod.

-- 1) Stripe webhook idempotency store. add_token_balance is additive, so a Stripe
--    retry or a replay of a captured signed payload must not credit twice. The
--    stripe-webhook function records each processed event id here (unique PK) and
--    skips crediting on a duplicate. Service_role only (RLS on, no policy).
create table if not exists public.webhook_events (
  id         text primary key,          -- stripe event id (evt_...)
  type       text,
  created_at timestamptz not null default now()
);
alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from anon, authenticated;

-- 2) provider_keys is WRITE-ONLY from the browser. The stored api_key must never
--    be selectable by anon/authenticated — not even for the caller's own account —
--    regardless of any future stray table-level SELECT grant. Replace the single
--    FOR ALL policy (which also governed SELECT) with explicit write policies and
--    NO select policy, then revoke the SELECT grant as belt-and-suspenders.
--    (Agents read keys server-side via service_role in _shared/keys.ts.)
drop policy if exists provider_keys_write on public.provider_keys;

create policy provider_keys_insert on public.provider_keys for insert
  with check (account_id = public.current_account_id());
create policy provider_keys_update on public.provider_keys for update
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
create policy provider_keys_delete on public.provider_keys for delete
  using (account_id = public.current_account_id());

revoke select on public.provider_keys from anon, authenticated;

-- 3) handle_new_user is a SECURITY DEFINER trigger that writes public.users
--    (incl. the is_admin flag) and public.accounts. It only runs from the
--    auth.users trigger; a client has no reason to hold EXECUTE on it. Revoke it
--    (same hygiene applied to the token-balance helpers in 20260627100000).
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ─── 20260703090000_ops_workflows.sql ────────────────────────────────────────────────────────
-- Ustudy Operations Team — real workflow persistence (Payment Control, Meeting to Tasks).
-- Reuses research_runs for the per-step agent trace + manager summary; adds tasks +
-- notifications so the two workflows produce durable, viewable business output.
-- Account-scoped via RLS like the rest of the schema.

-- tag each run by workflow kind + link it to the team department
alter table public.research_runs add column if not exists kind text not null default 'research';
  -- research | team_run | payment_control | meeting_to_tasks
alter table public.research_runs add column if not exists department_id uuid
  references public.departments(id) on delete set null;

-- tasks — Meeting-to-Tasks output (also usable for manual tasks)
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  run_id        uuid references public.research_runs(id) on delete set null,
  title         text not null,
  owner         text,
  deadline      date,
  priority      text not null default 'medium',    -- low | medium | high
  status        text not null default 'todo',       -- todo | in_progress | done | overdue
  source        text not null default 'meeting',    -- meeting | payment | manual
  details       text,
  created_at    timestamptz not null default now()
);

-- notifications — Payment-Control admin escalations (the "admin sees a task/notification")
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  run_id        uuid references public.research_runs(id) on delete set null,
  kind          text not null default 'admin_escalation', -- admin_escalation | payment_risk | task_assigned
  title         text not null,
  body          text,
  risk          text,                               -- low | medium | high
  target        text,                               -- admin this escalation is for
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table public.tasks         enable row level security;
alter table public.notifications enable row level security;

drop policy if exists tasks_acc on public.tasks;
create policy tasks_acc on public.tasks for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

drop policy if exists notifications_acc on public.notifications;
create policy notifications_acc on public.notifications for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists tasks_acc_idx on public.tasks (account_id, created_at desc);
create index if not exists notif_acc_idx on public.notifications (account_id, created_at desc);
create index if not exists research_runs_dept_idx on public.research_runs (department_id, created_at desc);

-- ─── 20260703140000_subagent_bots.sql ────────────────────────────────────────────────────────
-- Per-sub-agent Telegram bots + group "task-bot".
-- Each sub-agent can own its OWN Telegram bot (channels.sub_agent_id), answering
-- in its own persona. A bot can also run in a GROUP as a task-bot (scope='group'):
-- someone @mentions it and assigns a task to a person -> it creates a task row with
-- the assignee's Telegram identity and can remind them. Account-scoped via RLS.

-- ---------- channels: bind a bot to a specific sub-agent + declare its scope ----------
alter table public.channels add column if not exists sub_agent_id uuid
  references public.sub_agents(id) on delete cascade;
alter table public.channels add column if not exists scope text not null default 'dm';
  -- dm | group   (group = task-bot / team coordination chat)
alter table public.channels add column if not exists label text; -- display name in the UI

create index if not exists channels_sub_agent_idx on public.channels (sub_agent_id);

-- ---------- tasks: carry the Telegram assignee + source chat so the bot can remind ----------
alter table public.tasks add column if not exists channel_id uuid
  references public.channels(id) on delete set null;
alter table public.tasks add column if not exists telegram_chat_id text;  -- group the task came from
alter table public.tasks add column if not exists assignee_tg text;       -- @username or numeric user id
alter table public.tasks add column if not exists assignee_name text;     -- display name
alter table public.tasks add column if not exists created_by text;        -- who assigned it (tg name)
alter table public.tasks add column if not exists due_at timestamptz;     -- precise reminder time
alter table public.tasks add column if not exists last_reminded_at timestamptz;

create index if not exists tasks_due_idx on public.tasks (due_at) where status <> 'done';

-- ---------- telegram_members: the "special list of user ids" the task-bot keeps ----------
-- One row per person the bot has seen in a group, so it can resolve @mentions to a
-- real Telegram user and remind them personally.
create table if not exists public.telegram_members (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  channel_id    uuid references public.channels(id) on delete cascade,
  chat_id       text not null,
  tg_user_id    text not null,
  username      text,
  display_name  text,
  created_at    timestamptz not null default now(),
  unique(channel_id, chat_id, tg_user_id)
);

alter table public.telegram_members enable row level security;
drop policy if exists telegram_members_acc on public.telegram_members;
create policy telegram_members_acc on public.telegram_members for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists tg_members_chat_idx on public.telegram_members (channel_id, chat_id);

-- ─── 20260703160000_google_accounts.sql ──────────────────────────────────────────────────────
-- Google (Gmail/Sheets/Calendar) OAuth per account. The refresh_token is a secret:
-- RLS is ENABLED with NO client policy, so ONLY service_role (the edge functions)
-- can read/write it. The UI learns connection status via the google-oauth function,
-- never by reading this table directly.
create table if not exists public.google_accounts (
  account_id     uuid primary key references public.accounts(id) on delete cascade,
  google_email   text,
  refresh_token  text not null,
  scopes         text,
  connected_by   uuid references auth.users(id) on delete set null,
  connected_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.google_accounts enable row level security;
-- intentionally NO policies -> table is service-role only (secret refresh_token).

revoke all on public.google_accounts from anon, authenticated;

-- ─── 20260703180000_account_plan.sql ─────────────────────────────────────────────────────────
-- Per-account plan tier for cost control at scale. Expensive models (gpt-4o for the
-- orchestrator manager/synth) are reserved for paid tiers + admins; free accounts use
-- the cheap model. Metered by token_balance as before.
alter table public.accounts add column if not exists plan text not null default 'free';
  -- free | pro | business

-- ─── 20260704120000_google_oauth_apps.sql ────────────────────────────────────────────────────
-- Per-account Google OAuth app credentials.
-- Each business can connect Gmail/Sheets/Calendar using its OWN Google Cloud OAuth
-- client (self-service, no shared-app verification bottleneck). When an account has not
-- set its own, the platform falls back to the shared Nemo app (env GOOGLE_CLIENT_ID/
-- SECRET). Service-role only — the client_secret never leaves the server.
create table if not exists public.google_oauth_apps (
  account_id    uuid primary key references public.accounts(id) on delete cascade,
  client_id     text not null,
  client_secret text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.google_oauth_apps enable row level security;
-- No client policy on purpose: only service-role edge functions read/write these rows,
-- so RLS default-deny keeps the secret unreadable from any client (like google_accounts).

-- ─── 20260704160000_business_profiles.sql ────────────────────────────────────────────────────
-- Per-account BUSINESS PROFILE — "train the AI on your own business".
-- One row per account with the facts every agent/team should ground its work in
-- (marketing strategy, content, channel replies). Not secret: the owner reads/edits
-- it directly via RLS; edge functions read it via service role and inject it into prompts.
create table if not exists public.business_profiles (
  account_id  uuid primary key default public.current_account_id() references public.accounts(id) on delete cascade,
  name        text,
  industry    text,
  about       text,
  audience    text,
  offerings   text,
  tone        text,
  cities      text,
  links       text,
  extra       text,
  updated_at  timestamptz not null default now()
);

alter table public.business_profiles enable row level security;

-- ─── 20260704180000_scheduled_posts.sql ──────────────────────────────────────────────────────
-- Autoposting: scheduled content sent to a Telegram target by a connected bot.
-- A cron-driven function (autopost run_due) sends due posts and stamps status.
create table if not exists public.scheduled_posts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  channel_id   uuid references public.channels(id) on delete set null,  -- which connected bot sends it
  target_chat  text not null,                                           -- @channel or numeric chat id
  content      text not null,
  scheduled_at timestamptz not null,
  status       text not null default 'scheduled',                       -- scheduled | posted | failed | canceled
  posted_at    timestamptz,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists scheduled_posts_due_idx on public.scheduled_posts (scheduled_at) where status = 'scheduled';

alter table public.scheduled_posts enable row level security;

-- ─── 20260706120000_referral_antifarm.sql ────────────────────────────────────────────────────
-- Anti-farm hardening for the referral / signup economy (CSO finding).
--
-- Before: handle_new_user() paid +200 to BOTH sides at signup (auth.users INSERT),
-- i.e. before the invited user proved a real email. A script could mass-register
-- and farm the referrer's balance (200 x N) with throwaway/unconfirmed emails.
--
-- After:
--   * signup only RECORDS the referral link (accounts.referred_by),
--   * the +200/+200 bonus is paid ONCE, when the invited user's email is CONFIRMED
--     (or immediately for pre-verified OAuth signups),
--   * a per-referrer CAP limits how many referral bonuses one account can earn.
--
-- Requires email confirmation to be ON in Supabase Auth (Dashboard → Authentication)
-- for the email/password path — otherwise there is no confirmation event to gate on.

-- 1) Bookkeeping columns: idempotency flag + per-referrer counter.
alter table public.accounts add column if not exists referral_bonus_paid boolean not null default false;
alter table public.accounts add column if not exists referral_count      int     not null default 0;

-- 2) Shared payout. Idempotent (claims the payout atomically via the
--    referral_bonus_paid flag) and caps the referrer. Safe to call more than once.
create or replace function public.pay_referral_bonus(p_new_account uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ref_acc uuid;
  bonus   bigint := 200;  -- credits to each side on a confirmed referral
  cap     int    := 25;   -- max referral bonuses a single referrer can earn
  claimed int;
begin
  -- Atomically claim the one-time payout for this invited account. Only the first
  -- call where a referral link exists and the bonus is unpaid proceeds.
  update public.accounts
    set referral_bonus_paid = true
    where id = p_new_account
      and referred_by is not null
      and referral_bonus_paid = false
    returning referred_by into ref_acc;
  get diagnostics claimed = row_count;
  if claimed = 0 or ref_acc is null then
    return;
  end if;

  -- Referrer: credit only while under the cap (blocks unbounded Sybil farming).
  update public.accounts
    set token_balance  = token_balance + bonus,
        referral_count = referral_count + 1
    where id = ref_acc
      and referral_count < cap;

  -- Invited side: always gets its one-time bonus.
  update public.accounts
    set token_balance = token_balance + bonus
    where id = p_new_account;
end;
$$;

-- 3) Signup hook (auth.users INSERT): create account + user, record the referral
--    link, and pay the bonus IMMEDIATELY only when the email is already verified at
--    creation (OAuth / pre-confirmed). Email/password signups wait for confirmation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_account uuid;
  ref_code    text;
  ref_acc     uuid;
begin
  ref_code := upper(coalesce(new.raw_user_meta_data->>'ref', ''));
  insert into public.accounts (name, referral_code)
  values (coalesce(new.email, 'Nemo'), upper(substr(md5(new.id::text || random()::text), 1, 8)))
  returning id into new_account;

  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, coalesce(new.email, '') = 'redacted@invalid');

  if ref_code <> '' then
    select id into ref_acc from public.accounts where referral_code = ref_code and id <> new_account limit 1;
    if ref_acc is not null then
      update public.accounts set referred_by = ref_acc where id = new_account;
    end if;
  end if;

  -- Pre-verified signups (OAuth providers set email_confirmed_at at creation) can be
  -- paid right away; everyone else is paid by the confirmation trigger below.
  if new.email_confirmed_at is not null then
    perform public.pay_referral_bonus(new_account);
  end if;

  return new;
end;
$$;

-- 4) Confirmation hook (auth.users UPDATE): the moment email_confirmed_at flips from
--    NULL to set, pay the pending referral bonus for that user's account.
create or replace function public.handle_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  acc uuid;
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    select account_id into acc from public.users where id = new.id;
    if acc is not null then
      perform public.pay_referral_bonus(acc);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update on auth.users
  for each row execute function public.handle_email_confirmed();

-- 5) These run only as SECURITY DEFINER triggers / service-role helpers — no client
--    should hold EXECUTE (belt-and-suspenders; default-deny already applies).
revoke execute on function public.pay_referral_bonus(uuid)   from public, anon, authenticated;
revoke execute on function public.handle_email_confirmed()   from public, anon, authenticated;

-- ─── 20260706130000_follow_ups.sql ───────────────────────────────────────────────────────────
-- Auto follow-up / nurture sequences ("автоворонка дожима").
-- The AI keeps nudging a lead over several days (Telegram or email) until they
-- convert or opt out. Each row is one running sequence; the follow-up edge function
-- advances it on a schedule, generating each message from the conversation + the
-- business profile. Account-scoped via RLS like the rest of the schema.

create table if not exists public.follow_ups (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  agent_id     uuid references public.agents(id)   on delete set null,
  dialogue_id  uuid references public.dialogues(id) on delete set null,
  lead_id      uuid references public.leads(id)     on delete set null,
  channel      text not null default 'telegram',        -- telegram | email
  target       text not null,                           -- telegram chat id or email address
  goal         text not null default '',                -- what the sequence nudges toward
  status       text not null default 'active',          -- active | done | stopped | converted
  step         int  not null default 0,                 -- how many messages already sent
  max_steps    int  not null default 3,
  cadence_hours int[] not null default '{24,72,168}',   -- delay before step 1, 2, 3 ...
  next_run_at  timestamptz not null default now(),
  last_sent_at timestamptz,
  last_message text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.follow_ups enable row level security;

-- Owner can read + stop their own sequences from the UI. The follow-up edge function
-- writes/advances rows with the service_role key (bypasses RLS), like the other bots.
drop policy if exists follow_ups_acc on public.follow_ups;
create policy follow_ups_acc on public.follow_ups for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

-- the cron scan orders by (status, next_run_at); the account list orders by recency
create index if not exists follow_ups_due_idx on public.follow_ups (status, next_run_at);
create index if not exists follow_ups_acc_idx on public.follow_ups (account_id, created_at desc);

-- ─── 20260707150000_custom_tools.sql ─────────────────────────────────────────────────────────
-- Custom tools ("Мои инструменты") — the user teaches an agent a NEW skill without us
-- coding it: either a plain HTTP endpoint (URL + auth + parameter schema) or a whole MCP
-- server (a community tool bundle). Each enabled row becomes a callable function the model
-- can pick during runAgentTools. Secrets (auth headers) are read server-side only.
-- Account-scoped via RLS like the rest of the schema.

create table if not exists public.custom_tools (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  kind          text not null default 'http' check (kind in ('http', 'mcp')),
  name          text not null,                                 -- function name the model calls (a-z0-9_)
  description   text not null default '',                      -- when to use it (the model reads this)
  -- HTTP tool
  method        text not null default 'POST' check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  url           text not null default '',                      -- may contain {{param}} placeholders
  headers       jsonb not null default '{}'::jsonb,            -- static headers incl. Authorization (secret)
  params        jsonb not null default '[]'::jsonb,            -- [{name,type,description,required}]
  body_template text not null default '',                     -- optional JSON body with {{param}} placeholders
  -- MCP server
  mcp_url       text not null default '',                      -- streamable-HTTP MCP endpoint
  mcp_headers   jsonb not null default '{}'::jsonb,            -- auth headers for the MCP server (secret)
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.custom_tools enable row level security;

-- Owner manages their own tools from the UI. The reply bots read enabled rows with the
-- service_role key (bypasses RLS) to build the tool list, like the other server-side flows.
drop policy if exists custom_tools_acc on public.custom_tools;
create policy custom_tools_acc on public.custom_tools for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists custom_tools_acc_idx on public.custom_tools (account_id, created_at desc);

-- ─── 20260707170000_ops_watchdog.sql ─────────────────────────────────────────────────────────
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

-- ─── 20260707190000_ops_usage_today.sql ──────────────────────────────────────────────────────
-- Lightweight aggregate for the ops watchdog's cost guard: today's total tokens plus the
-- single top-spending account. Done in the DB (no row fetch) so it scales at 40k users.
create or replace function public.ops_usage_today()
returns table (total bigint, top_account uuid, top_tokens bigint)
language sql
security definer
set search_path = public
as $$
  with day as (
    select account_id, tokens from usage where created_at >= date_trunc('day', now())
  ), tops as (
    select account_id, sum(tokens) as t from day group by account_id order by t desc limit 1
  )
  select coalesce((select sum(tokens) from day), 0)::bigint,
         (select account_id from tops),
         coalesce((select t from tops), 0)::bigint;
$$;

revoke all on function public.ops_usage_today() from public;

-- ─── 20260707200000_ops_daily_digest.sql ─────────────────────────────────────────────────────
-- Per-account daily digest aggregate for the founder pulse agent. For every account that set
-- an operator/owner Telegram (business_profiles.notify_chat_id), returns yesterday's dialogues,
-- new leads and tokens burned — all computed in the DB (no row fetch) so it scales.
--
-- Keep the column creation in this migration: the function below references it, while the
-- following review-fixes migration only hardens the same column idempotently. A clean database
-- reset must therefore establish the dependency before PostgreSQL parses the function body.
alter table public.business_profiles add column if not exists notify_chat_id text;

create or replace function public.ops_daily_digest()
returns table (account_id uuid, notify_chat_id text, dialogues bigint, leads bigint, tokens bigint)
language sql
security definer
set search_path = public
as $$
  with y as (
    select (date_trunc('day', now()) - interval '1 day') as lo, date_trunc('day', now()) as hi
  ),
  d as (
    select ag.account_id, count(*)::bigint as c
    from dialogues dl join agents ag on ag.id = dl.agent_id, y
    where dl.created_at >= y.lo and dl.created_at < y.hi
    group by ag.account_id
  ),
  l as (
    select ag.account_id, count(*)::bigint as c
    from leads le
      join dialogues dl on dl.id = le.dialogue_id
      join agents ag on ag.id = dl.agent_id, y
    where le.created_at >= y.lo and le.created_at < y.hi
    group by ag.account_id
  ),
  t as (
    select u.account_id, sum(u.tokens)::bigint as s
    from usage u, y
    where u.created_at >= y.lo and u.created_at < y.hi
    group by u.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(d.c, 0)::bigint, coalesce(l.c, 0)::bigint, coalesce(t.s, 0)::bigint
  from business_profiles bp
  left join d on d.account_id = bp.account_id
  left join l on l.account_id = bp.account_id
  left join t on t.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_daily_digest() from public;

-- ─── 20260707210000_ops_review_fixes.sql ─────────────────────────────────────────────────────
-- Review fixes for the ops agents:
--  1) make the migration set reproducible — ensure business_profiles has the columns the
--     app/functions already rely on (present on prod, but never added by a committed migration);
--  2) close the SECURITY DEFINER leak properly — revoke EXECUTE from PUBLIC (the earlier
--     `revoke from anon, authenticated` left the default PUBLIC grant intact);
--  3) compute the day boundary in Asia/Tashkent (was UTC, shifting "today"/"yesterday" ~5h).

alter table public.business_profiles add column if not exists notify_chat_id text;
alter table public.business_profiles add column if not exists phone text;
alter table public.business_profiles add column if not exists tasks_sheet_id text;

-- today's total tokens + the single top-spending account (Tashkent day)
create or replace function public.ops_usage_today()
returns table (total bigint, top_account uuid, top_tokens bigint)
language sql
security definer
set search_path = public
as $$
  with b as (
    select (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent' as lo
  ), day as (
    select account_id, tokens from usage, b where created_at >= b.lo
  ), tops as (
    select account_id, sum(tokens) as t from day group by account_id order by t desc limit 1
  )
  select coalesce((select sum(tokens) from day), 0)::bigint,
         (select account_id from tops),
         coalesce((select t from tops), 0)::bigint;
$$;

-- per-account yesterday digest (Tashkent day) for accounts with an owner Telegram
create or replace function public.ops_daily_digest()
returns table (account_id uuid, notify_chat_id text, dialogues bigint, leads bigint, tokens bigint)
language sql
security definer
set search_path = public
as $$
  with y as (
    select (date_trunc('day', now() at time zone 'Asia/Tashkent') - interval '1 day') at time zone 'Asia/Tashkent' as lo,
           (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent' as hi
  ),
  d as (
    select ag.account_id, count(*)::bigint as c
    from dialogues dl join agents ag on ag.id = dl.agent_id, y
    where dl.created_at >= y.lo and dl.created_at < y.hi
    group by ag.account_id
  ),
  l as (
    select ag.account_id, count(*)::bigint as c
    from leads le join dialogues dl on dl.id = le.dialogue_id join agents ag on ag.id = dl.agent_id, y
    where le.created_at >= y.lo and le.created_at < y.hi
    group by ag.account_id
  ),
  t as (
    select u.account_id, sum(u.tokens)::bigint as s
    from usage u, y
    where u.created_at >= y.lo and u.created_at < y.hi
    group by u.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(d.c, 0)::bigint, coalesce(l.c, 0)::bigint, coalesce(t.s, 0)::bigint
  from business_profiles bp
  left join d on d.account_id = bp.account_id
  left join l on l.account_id = bp.account_id
  left join t on t.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_usage_today() from public;
revoke all on function public.ops_daily_digest() from public;
grant execute on function public.ops_usage_today() to service_role;
grant execute on function public.ops_daily_digest() to service_role;

-- ─── 20260707220000_ops_weekly_report.sql ────────────────────────────────────────────────────
-- Weekly team report aggregate: for every account with an owner Telegram, this week's task
-- stats (created / still open / overdue). Computed in the DB (Asia/Tashkent week). SECURITY
-- DEFINER, but EXECUTE revoked from PUBLIC (only the service role calls it from the cron fn).
create or replace function public.ops_weekly_report()
returns table (account_id uuid, notify_chat_id text, created bigint, open_cnt bigint, overdue bigint)
language sql
security definer
set search_path = public
as $$
  with w as (
    select (date_trunc('week', now() at time zone 'Asia/Tashkent') - interval '7 days') at time zone 'Asia/Tashkent' as lo
  ),
  agg as (
    select t.account_id,
      count(*) filter (where t.created_at >= w.lo)::bigint as created,
      count(*) filter (where coalesce(t.status,'open') <> 'done')::bigint as open_cnt,
      count(*) filter (where coalesce(t.status,'open') <> 'done' and t.due_at is not null and t.due_at < now())::bigint as overdue
    from tasks t, w
    group by t.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(a.created, 0)::bigint, coalesce(a.open_cnt, 0)::bigint, coalesce(a.overdue, 0)::bigint
  from business_profiles bp
  left join agg a on a.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_weekly_report() from public;
grant execute on function public.ops_weekly_report() to service_role;

-- ─── 20260707230000_planerka.sql ─────────────────────────────────────────────────────────────
-- Planerka (team stand-up) upgrade:
--  1) tasks carry PROOF of completion + partial PROGRESS + who/when closed it, so a person
--     can report "done" (with evidence) either in the group OR privately to the bot;
--  2) business_profiles gets a report language so the morning brief / weekly scorecard are
--     delivered in the language the owner picked (uz | ru | en);
--  3) ops_weekly_report keeps working; a new per-person scorecard RPC powers the weekly report
--     (promised / done / % / overdue-days), computed in the DB so it scales.
-- Account-scoped via RLS like the rest of the schema.

-- ---------- tasks: proof + progress + completion audit ----------
alter table public.tasks add column if not exists progress     int  not null default 0;   -- 0..100
alter table public.tasks add column if not exists proof_url    text;      -- telegram file_id or a link
alter table public.tasks add column if not exists proof_type   text;      -- photo | document | link | note
alter table public.tasks add column if not exists completed_at  timestamptz;
alter table public.tasks add column if not exists completed_by  text;     -- tg display name of who reported done

-- ---------- business_profiles: report language for briefs/reports ----------
alter table public.business_profiles add column if not exists report_lang text not null default 'ru';  -- uz | ru | en

-- ---------- per-person weekly scorecard (Asia/Tashkent week) ----------
-- One row per (chat, assignee): assigned this week, done this week, still open, overdue,
-- and the worst overdue-day count on their open tasks. SECURITY DEFINER; EXECUTE only for
-- the service role (the weekly-report cron function). Grouped in the DB so it scales at 40k.
create or replace function public.planerka_weekly_scorecard()
returns table (
  account_id       uuid,
  telegram_chat_id text,
  assignee         text,
  assigned         bigint,
  done             bigint,
  open_cnt         bigint,
  overdue          bigint,
  max_overdue_days int
)
language sql
security definer
set search_path = public
as $$
  with w as (
    select (date_trunc('week', now() at time zone 'Asia/Tashkent') - interval '7 days') at time zone 'Asia/Tashkent' as lo
  )
  select
    t.account_id,
    t.telegram_chat_id,
    coalesce(nullif(t.assignee_tg, ''), t.assignee_name, '—') as assignee,
    count(*) filter (where t.created_at >= w.lo)::bigint                                         as assigned,
    count(*) filter (where t.status = 'done' and coalesce(t.completed_at, t.created_at) >= w.lo)::bigint as done,
    count(*) filter (where coalesce(t.status,'todo') <> 'done')::bigint                          as open_cnt,
    count(*) filter (where coalesce(t.status,'todo') <> 'done' and t.due_at is not null and t.due_at < now())::bigint as overdue,
    coalesce(max(
      case when coalesce(t.status,'todo') <> 'done' and t.due_at is not null and t.due_at < now()
           then floor(extract(epoch from (now() - t.due_at)) / 86400)::int
           else 0 end
    ), 0) as max_overdue_days
  from tasks t, w
  where t.telegram_chat_id is not null
  group by t.account_id, t.telegram_chat_id, assignee;
$$;

-- lock it down: Supabase grants anon/authenticated EXECUTE directly, so revoking only from
-- PUBLIC leaves them able to call this SECURITY DEFINER function (which bypasses RLS and would
-- expose every account's chat ids + task counts). Revoke from all three, grant only the cron role.
revoke all on function public.planerka_weekly_scorecard() from public, anon, authenticated;
grant execute on function public.planerka_weekly_scorecard() to service_role;

-- Same hardening for the earlier ops DEFINER functions: `revoke ... from public` alone left
-- anon/authenticated able to EXECUTE them (Supabase grants those roles execute directly), which
-- exposed every account's notify chat + token totals. Revoke from all three; cron role only.
do $$
begin
  if to_regprocedure('public.ops_weekly_report()') is not null then
    revoke all on function public.ops_weekly_report() from public, anon, authenticated;
    grant execute on function public.ops_weekly_report() to service_role;
  end if;
  if to_regprocedure('public.ops_daily_digest()') is not null then
    revoke all on function public.ops_daily_digest() from public, anon, authenticated;
    grant execute on function public.ops_daily_digest() to service_role;
  end if;
  if to_regprocedure('public.ops_usage_today()') is not null then
    revoke all on function public.ops_usage_today() from public, anon, authenticated;
    grant execute on function public.ops_usage_today() to service_role;
  end if;
end $$;

-- ─── 20260707240000_task_assignee_id.sql ─────────────────────────────────────────────────────
-- Strong assignee identity for tasks. Closing a task via DM was authorized by matching the
-- task's assignee_name against the sender's Telegram display_name — a user-settable, non-unique
-- field (spoofable: rename your profile to a colleague's name). We add the assignee's numeric
-- Telegram user id (globally unique, non-spoofable) so completion is authorized by identity,
-- not by display name. Legacy/name-only tasks simply can't be closed via DM (must be done in
-- the group, where the bot verifies the sender's identity directly).
alter table public.tasks add column if not exists assignee_tg_user_id text;
create index if not exists tasks_assignee_uid_idx on public.tasks (assignee_tg_user_id) where status <> 'done';

-- ─── 20260707250000_agent_growth.sql ─────────────────────────────────────────────────────────
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

-- ─── 20260708120000_discuss_cooldown.sql ─────────────────────────────────────────────────────
-- Throttle the expensive group "discussion" (a single @mention fans out to ~6-7 LLM calls).
-- Any group member could repeat it and drain the account's token balance. We record when a
-- discussion last ran on a channel and enforce a cooldown before starting another.
alter table public.channels add column if not exists last_discussion_at timestamptz;

-- ─── 20260708130000_tg_updates.sql ───────────────────────────────────────────────────────────
-- Idempotency for the Telegram webhook. Telegram RE-DELIVERS an update if it doesn't receive a
-- fast 200 (slow LLM/tool work makes this common), which caused duplicate tasks and double LLM
-- spend. We record each processed update per bot and skip re-deliveries. Service-role only.
create table if not exists public.tg_updates (
  channel_id uuid        not null,
  update_id  bigint      not null,
  created_at timestamptz not null default now(),
  primary key (channel_id, update_id)
);

-- lock it down: only the service role (edge function) touches this; RLS with no policy denies
-- anon/authenticated entirely.
alter table public.tg_updates enable row level security;

create index if not exists tg_updates_created_idx on public.tg_updates (created_at);

-- ─── 20260708140000_ops_autopilot.sql ────────────────────────────────────────────────────────
-- Autonomous "AI COO" (autopilot): each day an agent reads the account's real state and
-- produces a short assessment + top actions, delivered to the owner and logged. This is the
-- "the platform runs itself" layer — no human needed to watch the numbers.

-- decisions log (per account), visible in the panel
create table if not exists public.ops_reports (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  kind       text not null default 'autopilot',
  summary    text,
  actions    jsonb,
  created_at timestamptz not null default now()
);
alter table public.ops_reports enable row level security;
drop policy if exists ops_reports_acc on public.ops_reports;
create policy ops_reports_acc on public.ops_reports for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
create index if not exists ops_reports_acc_idx on public.ops_reports (account_id, created_at desc);

-- per-account daily signals for the autopilot (Asia/Tashkent day). SECURITY DEFINER, service role only.
create or replace function public.ops_autopilot_signals()
returns table (
  account_id     uuid,
  notify_chat_id text,
  dialogues      bigint,
  leads          bigint,
  open_tasks     bigint,
  overdue_tasks  bigint,
  needs_operator bigint
)
language sql
security definer
set search_path = public
as $$
  with d as (
    select (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent' as lo
  ),
  dia as (
    select ag.account_id, count(*)::bigint c
    from dialogues dl join agents ag on ag.id = dl.agent_id, d
    where dl.created_at >= d.lo group by ag.account_id
  ),
  nop as (
    select ag.account_id, count(*)::bigint c
    from dialogues dl join agents ag on ag.id = dl.agent_id
    where dl.status = 'needs_operator' group by ag.account_id
  ),
  led as (
    select ag.account_id, count(*)::bigint c
    from leads le join dialogues dl on dl.id = le.dialogue_id join agents ag on ag.id = dl.agent_id, d
    where le.created_at >= d.lo group by ag.account_id
  ),
  tsk as (
    select t.account_id,
      count(*) filter (where coalesce(t.status,'todo') <> 'done')::bigint as open_cnt,
      count(*) filter (where coalesce(t.status,'todo') <> 'done' and t.due_at is not null and t.due_at < now())::bigint as overdue_cnt
    from tasks t group by t.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(dia.c,0), coalesce(led.c,0), coalesce(tsk.open_cnt,0), coalesce(tsk.overdue_cnt,0), coalesce(nop.c,0)
  from business_profiles bp
  left join dia on dia.account_id = bp.account_id
  left join nop on nop.account_id = bp.account_id
  left join led on led.account_id = bp.account_id
  left join tsk on tsk.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_autopilot_signals() from public, anon, authenticated;
grant execute on function public.ops_autopilot_signals() to service_role;

-- ─── 20260708150000_automations.sql ──────────────────────────────────────────────────────────
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

-- ─── 20260709000000_watched_sources.sql ──────────────────────────────────────────────────────
-- Channel watch → auto-localize. A user pastes a YouTube channel link once; a cron
-- polls its free RSS feed and, on each new video, localizes the title+description into
-- the chosen languages as content_drafts (Telegram can auto-publish; others are drafts).
-- All access goes through the watch-sources edge function (service role); RLS is enabled
-- with no permissive policies so the tables are not directly reachable by anon/authenticated.

create table if not exists public.watched_sources (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,
  url           text not null,
  kind          text not null default 'youtube',
  external_id   text,                       -- youtube channel id (UC...)
  title         text,
  languages     text[] not null default '{}',
  platforms     text[] not null default '{}',
  auto_publish  boolean not null default false,
  tg_channel_id uuid,                        -- channels.id of the sender bot (telegram auto-publish)
  tg_target     text,                        -- @channel the bot posts into
  last_video_id text,
  active        boolean not null default true,
  last_checked_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists watched_sources_account_idx on public.watched_sources(account_id);
create index if not exists watched_sources_active_idx on public.watched_sources(active) where active;
alter table public.watched_sources enable row level security;

create table if not exists public.content_drafts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  source_id    uuid references public.watched_sources(id) on delete set null,
  video_id     text,
  video_title  text,
  video_url    text,
  lang         text,
  content      text,
  status       text not null default 'draft',   -- draft | published
  published_to text,                             -- 'telegram' when auto-posted
  created_at   timestamptz not null default now()
);
create index if not exists content_drafts_account_idx on public.content_drafts(account_id, created_at desc);
alter table public.content_drafts enable row level security;

-- ─── 20260709010000_usage_dialogue.sql ───────────────────────────────────────────────────────
-- Token-economy: attribute AI usage to a dialogue so cost-per-conversation / per-lead is
-- computable (the < $0.05/lead unit-economics target). cost is now written per reply too.
alter table public.usage add column if not exists dialogue_id uuid;
create index if not exists usage_dialogue_idx on public.usage(dialogue_id) where dialogue_id is not null;

-- ─── 20260709020000_routing_decisions.sql ────────────────────────────────────────────────────
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

-- ─── 20260709030000_webhook_dedup.sql ────────────────────────────────────────────────────────
-- Idempotency for WhatsApp/Instagram (Meta redelivers a webhook if it doesn't get a fast 200).
-- Telegram already dedups via tg_updates; this covers the other channels. Service-role only.
create table if not exists public.webhook_dedup (
  channel_id uuid not null,
  msg_id     text not null,
  created_at timestamptz not null default now(),
  primary key (channel_id, msg_id)
);
alter table public.webhook_dedup enable row level security;

-- ─── 20260709040000_bookings.sql ─────────────────────────────────────────────────────────────
-- Internal bookings so a booking agent can ALWAYS schedule reliably (no hallucinated "записал"),
-- even when Google Calendar isn't connected. Written by the book_appointment tool. Service-role only.
create table if not exists public.bookings (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid references public.accounts(id) on delete cascade,
  dialogue_id    uuid,
  customer_name  text,
  phone          text,
  service        text,
  scheduled_at   timestamptz,
  scheduled_text text,        -- the date/time exactly as the customer said (fallback / reference)
  notes          text,
  status         text not null default 'booked',
  created_at     timestamptz not null default now()
);
create index if not exists bookings_account_idx on public.bookings(account_id, created_at desc);
alter table public.bookings enable row level security;

-- ─── 20260709050000_tool_runs.sql ────────────────────────────────────────────────────────────
-- tool_runs: audit trail of every agent tool execution (written by _shared/tools.ts, read by the
-- observability view). This table was referenced everywhere but never had a migration — so the
-- inserts were silently failing and the whole observability layer was empty. Service-role only.
create table if not exists public.tool_runs (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete cascade,
  tool       text,
  args       jsonb,
  result     text,
  ok         boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists tool_runs_account_idx on public.tool_runs(account_id, created_at desc);
create index if not exists tool_runs_tool_idx on public.tool_runs(tool, created_at desc);
alter table public.tool_runs enable row level security;

-- ─── 20260709060000_tg_queue.sql ─────────────────────────────────────────────────────────────
-- Durable queue for Telegram (#8): pgmq queue + RPC wrappers + a single-drainer lease.
create extension if not exists pgmq;
do $$ begin perform pgmq.create('tg_jobs'); exception when others then null; end $$;

create or replace function public.q_send(payload jsonb) returns bigint language sql security definer set search_path=pgmq,public as $$ select pgmq.send('tg_jobs', payload) $$;
create or replace function public.q_read(qty int, vt int default 30) returns setof pgmq.message_record language sql security definer set search_path=pgmq,public as $$ select * from pgmq.read('tg_jobs', vt, qty) $$;
create or replace function public.q_delete(mid bigint) returns boolean language sql security definer set search_path=pgmq,public as $$ select pgmq.delete('tg_jobs', mid) $$;
create or replace function public.q_len() returns bigint language sql security definer set search_path=pgmq,public as $$ select count(*)::bigint from pgmq.q_tg_jobs $$;

-- Lease: exactly one worker drains at a time (advisory locks don't survive the transaction pooler).
create table if not exists public.worker_lease (id int primary key, locked_until timestamptz not null default now());
insert into public.worker_lease(id, locked_until) values (1, now()) on conflict (id) do nothing;
create or replace function public.acquire_worker_lease(secs int default 60) returns boolean language sql as $$ update public.worker_lease set locked_until = now() + make_interval(secs => secs) where id = 1 and locked_until < now() returning true $$;
create or replace function public.release_worker_lease() returns boolean language sql as $$ update public.worker_lease set locked_until = now() where id = 1 returning true $$;

grant execute on function public.q_send(jsonb), public.q_read(int,int), public.q_delete(bigint), public.q_len(), public.acquire_worker_lease(int), public.release_worker_lease() to service_role;

-- ─── 20260709130000_rag_knowledge_chunks.sql ─────────────────────────────────────────────────
-- RAG: semantic knowledge base. The chunk/embed/retrieve pipeline was already coded
-- (_shared/knowledge.ts + knowledge-index function) but was dead because this DB side never
-- existed. This adds pgvector, the chunk store, a cosine-match RPC, and the indexes.
create extension if not exists vector;

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  doc_id uuid references public.knowledge_docs(id) on delete cascade,
  owner_id uuid not null,           -- the agent id
  owner_type text not null default 'agent',
  content text not null,
  embedding vector(384),            -- gte-small dimensions
  created_at timestamptz not null default now()
);

create index if not exists knowledge_chunks_owner_idx on public.knowledge_chunks (owner_id);
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- Chunks are written by service_role (knowledge-index) and read ONLY through the SECURITY DEFINER
-- RPC below (never directly by the browser). RLS on + no anon/auth policies = locked; service_role
-- bypasses RLS, the definer RPC bypasses RLS.
alter table public.knowledge_chunks enable row level security;

-- Top-k chunks for one owner by cosine similarity. SECURITY DEFINER so it can read the locked
-- table; only service_role may execute it (an authenticated user must NOT be able to pass an
-- arbitrary owner_id and read another account's chunks).
create or replace function public.match_knowledge(p_owner_id uuid, p_query vector(384), p_k int default 6)
returns table(content text, similarity double precision)
language sql stable security definer set search_path = public as $$
  select c.content, 1 - (c.embedding <=> p_query) as similarity
  from public.knowledge_chunks c
  where c.owner_id = p_owner_id and c.embedding is not null
  order by c.embedding <=> p_query
  limit greatest(1, least(p_k, 20))
$$;

revoke all on function public.match_knowledge(uuid, vector, int) from public, anon, authenticated;
grant execute on function public.match_knowledge(uuid, vector, int) to service_role;

-- ─── 20260709140000_social_credentials.sql ───────────────────────────────────────────────────
-- Autoposting connectors beyond Meta (Twitter/X, Reddit) need server-only credentials.
-- Create the table here as well so a fresh migration chain never tries to ALTER a missing table.
create table if not exists public.social_accounts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  platform     text not null,
  access_token text,
  page_id      text,
  ig_user_id   text,
  label        text,
  credentials  jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, platform)
);
alter table public.social_accounts add column if not exists credentials jsonb;
alter table public.social_accounts enable row level security;

-- ─── 20260709160000_agent_persona_and_skills.sql ─────────────────────────────────────────────
-- Personal-assistant mode (an agent that answers in Telegram AS one specific person, not the
-- organization) + user-selectable agent skills (capability bundles like data analysis).
alter table public.agents add column if not exists persona_mode text not null default 'business';
alter table public.agents add column if not exists owner_name text;
alter table public.agents add column if not exists skills text[] not null default '{}';

-- ─── 20260709170000_planerka_members_sheet.sql ───────────────────────────────────────────────
-- A company connects its OWN Google Sheet as the planerka team roster (name + Telegram chat_id +
-- username + department). The planerka reads it to DM each person their tasks directly.
alter table public.business_profiles add column if not exists planerka_members_sheet_id text;
alter table public.business_profiles add column if not exists planerka_members_tab text;      -- optional tab/sheet name
alter table public.business_profiles add column if not exists planerka_members_map jsonb not null default '{}'::jsonb; -- optional column overrides {name,chatId,username,dept}

-- ─── 20260710120000_messages_system_trace_rls.sql ────────────────────────────────────────────
-- Messages write hardening: protect system_trace audit rows from client tampering.
--
-- system_trace rows are the operator-facing audit trail of how agents collaborated
-- on a reply. They are written ONLY by the agent runtime through service_role
-- (buildReply in supabase/functions/_shared/agent.ts — its callers telegram-webhook,
-- whatsapp-webhook and widget-webhook all use SUPABASE_SERVICE_ROLE_KEY clients).
-- Before this migration, the single messages_acc FOR ALL policy (from
-- 20260624150000_review_fixes.sql) let any authenticated tenant client
-- INSERT/UPDATE/DELETE its own system_trace rows — i.e. forge or erase the audit
-- trail of its own account.
--
-- New model — tenant scope is byte-identical to the old policy:
--   * SELECT: whole tenant scope, all message_type values. The dialogues panel
--     keeps rendering traces and RLS-filtered realtime events keep flowing.
--   * INSERT / UPDATE / DELETE: tenant scope AND message_type = 'chat'. Clients
--     may only write chat rows. This is backward compatible today: the frontend
--     performs no direct messages writes, and the two Edge Functions that write
--     with the CALLER'S JWT (operator-send, test-agent) insert without
--     message_type, so the column default 'chat' satisfies the new policy.
--     UPDATE checks both the old row (USING) and the new row (WITH CHECK), so a
--     trace row cannot be edited AND a chat row cannot be rewritten into a fake
--     trace. internal_monologue rows get the same protection (clients should
--     never write those either). service_role bypasses RLS as before.
--   * Policies are TO authenticated: anon was already fully blocked in practice
--     (current_account_id() is null without a session); now it is explicit.
--
-- Known limitation (documented, intentionally out of scope): this blocks DIRECT
-- trace-row mutation only. A tenant can still lose traces by deleting the parent
-- agent/dialogue (FK ON DELETE CASCADE — cascades are not filtered by the child
-- table's DELETE policy). Immutable retention would need a separate append-only
-- audit table or soft deletes.

drop policy if exists messages_acc on public.messages;
drop policy if exists messages_select_acc on public.messages;
drop policy if exists messages_insert_chat on public.messages;
drop policy if exists messages_update_chat on public.messages;
drop policy if exists messages_delete_chat on public.messages;

create policy messages_select_acc on public.messages for select
  to authenticated
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

create policy messages_insert_chat on public.messages for insert
  to authenticated
  with check (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

create policy messages_update_chat on public.messages for update
  to authenticated
  using (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  )
  with check (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

create policy messages_delete_chat on public.messages for delete
  to authenticated
  using (
    message_type = 'chat'
    and dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );

-- ─── 20260710130000_trace_retention_guard.sql ────────────────────────────────────────────────
-- Trace retention guard: close the cascade-delete hole left by
-- 20260710120000_messages_system_trace_rls.sql.
--
-- That migration made system_trace audit rows read-only for client roles, but
-- documented one remaining path: FK ON DELETE CASCADE. Deleting a parent agent
-- (agents -> dialogues -> messages) or dialogue (dialogues -> messages) erased
-- the tenant's own audit trail even though direct trace writes/deletes were
-- blocked, because cascaded deletes are not filtered by the child table's
-- DELETE policy.
--
-- Fix: BEFORE DELETE row triggers on both parent tables. A SECURITY DEFINER
-- function (owner = table owner, so RLS on public.messages cannot hide rows
-- from the check) refuses the delete for client roles when the entity still
-- has system_trace rows underneath it. Entities with no traces stay deletable
-- by tenants exactly as before.
--
-- Caller gate (fail closed):
--   * request.jwt.claims role = 'service_role'  -> allowed (runtime/admin
--     Edge Functions; they can archive + clean up).
--   * no JWT claims AND session_user is a direct trusted DB session
--     (postgres / supabase_admin: migrations, dashboard SQL, pg_cron)
--     -> allowed.
--   * everything else — authenticated, anon, or any unknown/missing role
--     arriving through the API authenticator — is guarded. "Guarded" only
--     means the trace check applies; deletes of trace-free entities still
--     succeed, so an unexpected context degrades safely, not destructively.
--
-- Because row triggers also fire on rows deleted BY a cascade, deeper paths
-- (e.g. deleting an account cascades into agents) are covered by the same
-- guard under the same request GUCs.

-- FK join path used by the agents-side check (and generally missing for the
-- dialogues.agent_id FK).
create index if not exists dialogues_agent_id_idx on public.dialogues (agent_id);

create or replace function public.guard_trace_parent_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
  has_trace boolean;
begin
  if requester = 'service_role' then
    return old;
  end if;
  if requester is null and session_user in ('postgres', 'supabase_admin') then
    return old;
  end if;

  if tg_table_name = 'agents' then
    select exists (
      select 1
      from public.messages m
      join public.dialogues d on d.id = m.dialogue_id
      where d.agent_id = old.id
        and m.message_type = 'system_trace'
    ) into has_trace;
  elsif tg_table_name = 'dialogues' then
    select exists (
      select 1
      from public.messages m
      where m.dialogue_id = old.id
        and m.message_type = 'system_trace'
    ) into has_trace;
  else
    raise exception 'guard_trace_parent_delete is attached to unexpected table %.%', tg_table_schema, tg_table_name
      using errcode = '42809'; -- wrong_object_type: refuse rather than guess
  end if;

  if has_trace then
    raise exception 'cannot delete % %: it still has system_trace audit rows', tg_table_name, old.id
      using errcode = '42501', -- insufficient_privilege -> PostgREST 403
            hint = 'system_trace rows are the retained audit trail of agent collaboration; an administrator (service role) must archive or remove them first.';
  end if;

  return old;
end;
$$;

drop trigger if exists agents_guard_trace_delete on public.agents;
create trigger agents_guard_trace_delete
  before delete on public.agents
  for each row
  execute function public.guard_trace_parent_delete();

drop trigger if exists dialogues_guard_trace_delete on public.dialogues;
create trigger dialogues_guard_trace_delete
  before delete on public.dialogues
  for each row
  execute function public.guard_trace_parent_delete();

-- ─── 20260711150000_autopost_repair.sql ──────────────────────────────────────────────────────
-- Repair and harden autoposting so a fresh project matches the Edge Functions.

create table if not exists public.social_accounts (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  platform     text not null,
  access_token text,
  page_id      text,
  ig_user_id   text,
  label        text,
  credentials  jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (account_id, platform)
);

alter table public.social_accounts add column if not exists access_token text;
alter table public.social_accounts add column if not exists page_id text;
alter table public.social_accounts add column if not exists ig_user_id text;
alter table public.social_accounts add column if not exists label text;
alter table public.social_accounts add column if not exists credentials jsonb;
alter table public.social_accounts add column if not exists created_at timestamptz not null default now();
alter table public.social_accounts add column if not exists updated_at timestamptz not null default now();
create unique index if not exists social_accounts_account_platform_uidx on public.social_accounts (account_id, platform);
alter table public.social_accounts enable row level security;

alter table public.scheduled_posts add column if not exists platform text not null default 'telegram';
alter table public.scheduled_posts add column if not exists media_url text;
alter table public.scheduled_posts add column if not exists claimed_at timestamptz;
alter table public.scheduled_posts add column if not exists attempt_count integer not null default 0;
alter table public.scheduled_posts alter column target_chat drop not null;

alter table public.scheduled_posts drop constraint if exists scheduled_posts_status_check;
alter table public.scheduled_posts add constraint scheduled_posts_status_check
  check (status in ('scheduled', 'processing', 'posted', 'failed', 'canceled'));
alter table public.scheduled_posts drop constraint if exists scheduled_posts_platform_check;
alter table public.scheduled_posts add constraint scheduled_posts_platform_check
  check (platform in ('telegram', 'facebook', 'instagram', 'twitter', 'reddit', 'tiktok', 'youtube'));

create index if not exists scheduled_posts_claim_idx
  on public.scheduled_posts (status, scheduled_at, claimed_at);

-- Atomically claim due rows. SKIP LOCKED prevents duplicate posts when two cron
-- invocations overlap; stale processing rows can be retried after 15 minutes.
create or replace function public.claim_due_scheduled_posts(p_limit integer default 50)
returns setof public.scheduled_posts
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select id
    from public.scheduled_posts
    where (status = 'scheduled' and scheduled_at <= now())
       or (status = 'processing' and claimed_at < now() - interval '15 minutes')
    order by scheduled_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  update public.scheduled_posts p
  set status = 'processing', claimed_at = now(), attempt_count = p.attempt_count + 1
  from candidates c
  where p.id = c.id
  returning p.*;
$$;

revoke all on function public.claim_due_scheduled_posts(integer) from public, anon, authenticated;
grant execute on function public.claim_due_scheduled_posts(integer) to service_role;

-- Dialogue-linked follow-ups resolve the target from the dialogue and must be
-- allowed to omit a duplicated raw chat ID.
alter table if exists public.follow_ups alter column target drop not null;
alter table if exists public.follow_ups add column if not exists claimed_at timestamptz;
alter table if exists public.follow_ups add column if not exists attempt_count integer not null default 0;

create or replace function public.claim_due_follow_ups(p_limit integer default 50)
returns setof public.follow_ups
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select id
    from public.follow_ups
    where (status = 'active' and next_run_at <= now())
       or (status = 'processing' and claimed_at < now() - interval '15 minutes')
    order by next_run_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  update public.follow_ups f
  set status = 'processing', claimed_at = now(), attempt_count = f.attempt_count + 1, updated_at = now()
  from candidates c
  where f.id = c.id
  returning f.*;
$$;

revoke all on function public.claim_due_follow_ups(integer) from public, anon, authenticated;
grant execute on function public.claim_due_follow_ups(integer) to service_role;

-- ─── 20260711160000_logistics_workflow.sql ───────────────────────────────────────────────────
-- Durable lookup paths for Logistics Control tasks, delay alerts and approval drafts.
alter table public.tasks add column if not exists subject_key text;

create index if not exists tasks_logistics_open_idx
  on public.tasks (account_id, department_id, status, created_at desc)
  where source = 'logistics';

create unique index if not exists tasks_logistics_exception_open_uidx
  on public.tasks (account_id, department_id, source, subject_key)
  where source = 'logistics' and status <> 'done' and subject_key is not null;

create index if not exists notifications_logistics_idx
  on public.notifications (account_id, department_id, kind, target, created_at desc)
  where kind in ('delay_alert', 'logistics_escalation', 'approval_request');

-- Reserve the full bounded workflow budget atomically before using Nemo's shared
-- model key. The function caps input at 40 rows / 12k characters and both model
-- calls cap output at 1800 tokens, so 50 credits is a conservative upper bound.
-- Finalization refunds every unused reserved credit.
create or replace function public.reserve_logistics_credits(p_account uuid, p_credits bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare affected integer := 0;
begin
  if p_credits < 1 or p_credits > 50 then return false; end if;
  update public.accounts
     set token_balance = token_balance - p_credits
   where id = p_account and token_balance >= p_credits;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.finalize_logistics_credits(p_account uuid, p_reserved bigint, p_tokens bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.accounts
     set token_balance = token_balance + greatest(0, p_reserved - ceil(greatest(p_tokens, 0) / 1000.0)::bigint)
   where id = p_account;
$$;

revoke execute on function public.reserve_logistics_credits(uuid, bigint) from public, anon, authenticated;
revoke execute on function public.finalize_logistics_credits(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reserve_logistics_credits(uuid, bigint) to service_role;
grant execute on function public.finalize_logistics_credits(uuid, bigint, bigint) to service_role;

-- ─── 20260711200000_industry_risk_policy.sql ─────────────────────────────────────────────────
-- Server-enforced safety tier for regulated industry teams.
-- The tier is persisted outside editable prompt/niche text, cannot be downgraded,
-- and a database trigger blocks every channel write regardless of API/RLS path.

alter table public.agents
  add column if not exists risk_tier text not null default 'standard';

alter table public.agents
  add column if not exists template_key text;

alter table public.channels
  add column if not exists quarantined_credentials jsonb;

update public.agents
set risk_tier = 'standard'
where risk_tier is null or risk_tier not in ('standard', 'regulated');
alter table public.agents alter column risk_tier set default 'standard';
alter table public.agents alter column risk_tier set not null;

alter table public.agents drop constraint if exists agents_risk_tier_check;
alter table public.agents
  add constraint agents_risk_tier_check
  check (risk_tier in ('standard', 'regulated'));

create index if not exists agents_risk_tier_idx on public.agents (risk_tier);

create or replace function public.enforce_agent_risk_tier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.risk_tier := coalesce(new.risk_tier, 'standard');

  if tg_op = 'INSERT' then
    if new.template_key in (
      'hr-recruiting',
      'clinic-front-desk',
      'accounting-collections',
      'legal-office',
      'insurance-operations'
    ) or coalesce(new.niche, '') ~* '(^|[[:space:]])nemo-risk:regulated([[:space:]]|$)' then
      new.risk_tier := 'regulated';
    end if;
    return new;
  end if;

  if old.template_key is not null and new.template_key is distinct from old.template_key then
    raise exception 'agent template key cannot be changed or removed'
      using errcode = '42501';
  end if;

  if old.risk_tier = 'regulated' and new.risk_tier <> 'regulated' then
    raise exception 'regulated agent risk tier cannot be downgraded'
      using errcode = '42501';
  end if;

  if new.template_key in (
    'hr-recruiting',
    'clinic-front-desk',
    'accounting-collections',
    'legal-office',
    'insurance-operations'
  ) or coalesce(new.niche, '') ~* '(^|[[:space:]])nemo-risk:regulated([[:space:]]|$)' then
    new.risk_tier := 'regulated';
  end if;

  if new.risk_tier = 'regulated' and old.risk_tier <> 'regulated' then
    update public.channels
    set quarantined_credentials = case
          when credentials <> '{}'::jsonb then credentials
          else quarantined_credentials
        end,
        credentials = '{}'::jsonb,
        status = 'safety_blocked'
    where agent_id = old.id;
  end if;
  return new;
end;
$$;

drop trigger if exists agents_risk_tier_guard on public.agents;
create trigger agents_risk_tier_guard
  before insert or update of risk_tier, template_key, niche on public.agents
  for each row execute function public.enforce_agent_risk_tier();

create or replace function public.block_regulated_agent_channel()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_tier text;
begin
  select a.risk_tier into target_tier
  from public.agents as a
  where a.id = new.agent_id
  for update;

  if target_tier = 'regulated' and (
    tg_op = 'INSERT'
    or new.status <> 'safety_blocked'
    or new.credentials <> '{}'::jsonb
  ) then
    raise exception 'live channels are disabled for regulated safety-beta teams'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists channels_regulated_agent_guard on public.channels;
create trigger channels_regulated_agent_guard
  before insert or update of agent_id, status, credentials on public.channels
  for each row execute function public.block_regulated_agent_channel();

-- Upgrade any template rows created during a rolling deployment. The update
-- trigger preserves credentials and quarantines an already-connected channel.
update public.agents
set risk_tier = 'regulated'
where risk_tier = 'standard'
  and niche ~* '(^|[[:space:]])nemo-risk:regulated([[:space:]]|$)';

-- Self-heal a partial/rolling deployment: no active credential remains in the
-- column read by outbound jobs, while a server-only DB copy is retained
-- for a future, explicitly approved restoration migration.
update public.channels as c
set quarantined_credentials = case
      when c.credentials <> '{}'::jsonb then c.credentials
      else c.quarantined_credentials
    end,
    credentials = '{}'::jsonb,
    status = 'safety_blocked'
from public.agents as a
where a.id = c.agent_id
  and a.risk_tier = 'regulated'
  and (
    c.status <> 'safety_blocked'
    or c.credentials <> '{}'::jsonb
  );

-- ─── 20260711210000_channel_safe_read_columns.sql ────────────────────────────────────────────
-- Keep channel credentials server-only while allowing the UI to read the
-- non-secret metadata added for team and specialist Telegram connections.
revoke select on public.channels from anon, authenticated;

grant select (
  id,
  agent_id,
  type,
  status,
  created_at,
  sub_agent_id,
  scope,
  label
) on public.channels to anon, authenticated;

-- ─── 20260713120000_governed_agent_evolution.sql ─────────────────────────────────────────────
-- Governed autonomous agent evolution. Prompt changes may be applied automatically only
-- after an independent quality/safety review. Every change remains auditable and reversible.
alter table public.agent_evolutions
  add column if not exists auto_applied boolean not null default false,
  add column if not exists review_score integer,
  add column if not exists review_summary text,
  add column if not exists applied_at timestamptz,
  add column if not exists rolled_back_at timestamptz;

alter table public.agent_evolutions
  drop constraint if exists agent_evolutions_review_score_check;
alter table public.agent_evolutions
  add constraint agent_evolutions_review_score_check
  check (review_score is null or review_score between 0 and 100);

create index if not exists agent_evolutions_auto_applied_idx
  on public.agent_evolutions (agent_id, applied_at desc)
  where auto_applied = true;

-- ─── 20260713150000_product_intelligence.sql ─────────────────────────────────────────────────
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

-- ─── 20260713190000_security_gate_hardening.sql ──────────────────────────────────────────────
-- Security gate: bound knowledge payloads and serialize agent creation bursts.

alter table public.knowledge_docs
  drop constraint if exists knowledge_docs_content_size_check;
alter table public.knowledge_docs
  add constraint knowledge_docs_content_size_check
  check (content is null or char_length(content) <= 200000) not valid;
alter table public.knowledge_docs validate constraint knowledge_docs_content_size_check;

alter table public.knowledge_docs
  drop constraint if exists knowledge_docs_name_size_check;
alter table public.knowledge_docs
  add constraint knowledge_docs_name_size_check
  check (name is null or char_length(name) <= 255) not valid;
alter table public.knowledge_docs validate constraint knowledge_docs_name_size_check;

create or replace function public.guard_agent_creation_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare recent_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.account_id::text, 913));
  select count(*) into recent_count
  from public.agents
  where account_id = new.account_id
    and created_at >= now() - interval '1 minute';
  if recent_count >= 30 then
    raise exception 'agent creation rate limit exceeded' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists agents_creation_rate_guard on public.agents;
create trigger agents_creation_rate_guard
  before insert on public.agents
  for each row execute function public.guard_agent_creation_rate();

revoke execute on function public.guard_agent_creation_rate() from public, anon, authenticated;

-- ─── 20260714090000_leads_concurrency.sql ────────────────────────────────────────────────────
-- Leads concurrency hardening (security gate #29 "Concurrent CRM subagents").
-- Concurrent agent turns on one dialogue previously did read-merge-write on
-- leads.fields (last write silently dropped the other turn's captured fields),
-- could insert duplicate lead rows for one dialogue, and could push the same
-- lead to the external CRM twice. This migration moves the merge, the
-- get-or-create and the CRM-push claim into atomic, serialized SQL.
--
-- Design notes:
-- * Same-dialogue serialization uses pg_advisory_xact_lock instead of a unique
--   index on dialogue_id because production may already hold duplicate rows
--   and follow_ups.lead_id references them (deleting/merging legacy rows is a
--   separate, riskier cleanup). The canonical row is the newest by
--   (created_at desc, id desc); fields hidden in older legacy duplicates stay
--   hidden, which matches the previous reader behavior.
-- * CRM-push claim state lives in typed columns, not in the exported
--   leads.fields JSONB. The claim self-expires after 10 minutes so a crashed
--   function cannot wedge a lead forever; CRM HTTP calls time out well below
--   the lease. Guarantee: single concurrent claimant, at-least-once delivery.
--   An ambiguous provider failure (timeout / network) must NOT release the
--   claim — the runtime lets the lease expire instead, because the remote CRM
--   may have accepted the lead after our timeout fired.
-- * Functions are SECURITY INVOKER and executable by service_role only:
--   every buildReply caller (telegram/whatsapp/instagram/widget processors)
--   already uses a service-role client, and browser roles must not reach a
--   cross-tenant write path. p_account_id is still verified against the
--   dialogue -> agent -> account chain to prevent confused-deputy bugs.

alter table public.leads add column if not exists crm_push_claimed_at timestamptz;
alter table public.leads add column if not exists crm_push_claim uuid;

-- Legacy rows recorded a completed push only inside fields.crm_pushed; promote
-- it to the typed pushed_to_crm column the new claim predicate relies on.
-- Only actual provider markers count — the key was reachable by user-controlled
-- lead-form labels, so any other value is junk and is scrubbed, not honored.
update public.leads set pushed_to_crm = true
  where pushed_to_crm = false and fields->>'crm_pushed' in ('bitrix24', 'amocrm', 'hubspot');
update public.leads set fields = fields - 'crm_pushed'
  where pushed_to_crm = false and fields ? 'crm_pushed';

-- Browser roles only ever READ leads (inbox list + CSV export); every write
-- must go through the RPCs below, or an authenticated client could bypass the
-- serialization, duplicate rows, or forge claim state. Replace the FOR ALL
-- policy with select-only and revoke DML outright.
drop policy if exists leads_acc on public.leads;
drop policy if exists leads_select_acc on public.leads;
create policy leads_select_acc on public.leads for select to authenticated
  using (
    dialogue_id in (
      select id from public.dialogues
      where agent_id in (select id from public.agents where account_id = public.current_account_id())
    )
  );
revoke insert, update, delete on public.leads from anon, authenticated;

-- Deterministic canonical-row selection (newest lead per dialogue).
create index if not exists leads_dialogue_latest_idx
  on public.leads (dialogue_id, created_at desc, id desc);

-- Atomic get-or-create + JSONB merge for one dialogue's lead. Serialized per
-- dialogue, so two concurrent turns cannot lose each other's keys or insert
-- duplicate rows. The incoming patch wins same-key conflicts in lock/commit
-- order (which may differ from customer-message order); disjoint keys are
-- never lost, matching the previous {...existing, ...clean} semantics.
create or replace function public.merge_lead_fields(p_account_id uuid, p_dialogue_id uuid, p_patch jsonb)
returns table (lead_id uuid, lead_fields jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_fields jsonb;
begin
  if p_account_id is null or p_dialogue_id is null then
    raise exception 'merge_lead_fields: account and dialogue are required' using errcode = '22004';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'merge_lead_fields: patch must be a JSON object' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.dialogues d
    join public.agents a on a.id = d.agent_id
    where d.id = p_dialogue_id and a.account_id = p_account_id
  ) then
    raise exception 'merge_lead_fields: dialogue does not belong to account' using errcode = '42501';
  end if;
  -- serialize concurrent turns of the same dialogue (get-or-create must not race)
  perform pg_advisory_xact_lock(hashtextextended(p_dialogue_id::text, 917));
  select l.id into v_id
  from public.leads l
  where l.dialogue_id = p_dialogue_id
  order by l.created_at desc, l.id desc
  limit 1
  for update;
  if v_id is null then
    insert into public.leads (dialogue_id, fields, status)
    values (p_dialogue_id, p_patch, 'new')
    returning id, fields into v_id, v_fields;
  else
    update public.leads set fields = fields || p_patch where id = v_id
    returning fields into v_fields;
  end if;
  return query select v_id, v_fields;
end;
$$;

-- Single-claimant CRM push. Returns a claim token + the row's CURRENT fields
-- (the push must use fresh data, not the caller's snapshot); returns no row
-- when the lead is already pushed or another turn holds a live claim. The
-- provider-valued fields->>'crm_pushed' guard also covers rows written by
-- pre-migration function code during the deploy window (junk values written
-- through a hostile lead-form label must not block the claim).
create or replace function public.claim_lead_crm_push(p_account_id uuid, p_lead_id uuid)
returns table (claim_token uuid, lead_fields jsonb)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_token uuid := gen_random_uuid();
  v_fields jsonb;
begin
  if p_account_id is null or p_lead_id is null then
    raise exception 'claim_lead_crm_push: account and lead are required' using errcode = '22004';
  end if;
  update public.leads l
  set crm_push_claim = v_token,
      crm_push_claimed_at = now()
  where l.id = p_lead_id
    and l.pushed_to_crm = false
    and coalesce(l.fields->>'crm_pushed', '') not in ('bitrix24', 'amocrm', 'hubspot')
    and (l.crm_push_claimed_at is null or l.crm_push_claimed_at < now() - interval '10 minutes')
    and exists (
      select 1
      from public.dialogues d
      join public.agents a on a.id = d.agent_id
      where d.id = l.dialogue_id and a.account_id = p_account_id
    )
  returning l.fields into v_fields;
  if not found then
    return;
  end if;
  return query select v_token, v_fields;
end;
$$;

-- Finish a claimed push. p_provider set = success (records the push and keeps
-- the provider visible in fields.crm_pushed for the UI/CSV); p_provider null =
-- definite failure (releases the claim so the next turn retries immediately
-- instead of waiting out the lease). Only the token holder can finish.
create or replace function public.finish_lead_crm_push(p_account_id uuid, p_lead_id uuid, p_token uuid, p_provider text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if p_account_id is null or p_lead_id is null or p_token is null then
    raise exception 'finish_lead_crm_push: account, lead and token are required' using errcode = '22004';
  end if;
  if p_provider is null then
    update public.leads l
    set crm_push_claim = null,
        crm_push_claimed_at = null
    where l.id = p_lead_id
      and l.crm_push_claim = p_token
      and exists (
        select 1
        from public.dialogues d
        join public.agents a on a.id = d.agent_id
        where d.id = l.dialogue_id and a.account_id = p_account_id
      );
  else
    update public.leads l
    set pushed_to_crm = true,
        crm_push_claim = null,
        crm_push_claimed_at = null,
        fields = l.fields || jsonb_build_object('crm_pushed', left(p_provider, 40))
    where l.id = p_lead_id
      and l.crm_push_claim = p_token
      and exists (
        select 1
        from public.dialogues d
        join public.agents a on a.id = d.agent_id
        where d.id = l.dialogue_id and a.account_id = p_account_id
      );
  end if;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.merge_lead_fields(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.claim_lead_crm_push(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_lead_crm_push(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.merge_lead_fields(uuid, uuid, jsonb) to service_role;
grant execute on function public.claim_lead_crm_push(uuid, uuid) to service_role;
grant execute on function public.finish_lead_crm_push(uuid, uuid, uuid, text) to service_role;

-- ─── 20260714100000_team_shared_rag.sql ──────────────────────────────────────────────────────
-- Team-shared RAG (release 2026-07). A department becomes a first-class
-- knowledge owner: knowledge_docs.owner_type gains a working 'team' branch
-- (owner_id = department id) with tenant-scoped RLS, and retrieval gets an
-- account-aware RPC that reads the agent's own docs plus its department's
-- shared docs. The RPC verifies every owner id against p_account_id
-- (fail-closed) and joins through knowledge_docs, so a stale owner column on
-- knowledge_chunks can never leak another owner's content.

-- 1) two-branch document policy: browser CRUD stays tenant-scoped per branch.
--    (The previous policy only recognized agent owners, which made any other
--    owner_type unreachable.)
drop policy if exists knowledge_acc on public.knowledge_docs;
create policy knowledge_acc on public.knowledge_docs for all
  using (
    (owner_type = 'agent' and owner_id in (select id from public.agents where account_id = public.current_account_id()))
    or (owner_type = 'team' and owner_id in (select id from public.departments where account_id = public.current_account_id()))
  )
  with check (
    (owner_type = 'agent' and owner_id in (select id from public.agents where account_id = public.current_account_id()))
    or (owner_type = 'team' and owner_id in (select id from public.departments where account_id = public.current_account_id()))
  );

-- owner_type is now load-bearing: constrain new rows to the known kinds without
-- failing the migration on unaudited legacy values (NOT VALID skips old rows).
alter table public.knowledge_docs drop constraint if exists knowledge_docs_owner_type_check;
alter table public.knowledge_docs add constraint knowledge_docs_owner_type_check
  check (owner_type in ('agent', 'team', 'account')) not valid;

-- 2) chunks inherit the truth from their parent doc (corrects stale copies).
update public.knowledge_chunks c
   set owner_type = d.owner_type, owner_id = d.owner_id
  from public.knowledge_docs d
 where c.doc_id = d.id
   and (c.owner_type is distinct from d.owner_type or c.owner_id is distinct from d.owner_id);

-- 3) tenant integrity for the team graph: a department may only lead agents of
--    its own account, and a sub-agent's department must belong to the
--    sub-agent's account. RLS alone checks account_id columns but not these
--    relationships, and service-role runtime queries traverse them.
--    Pre-existing cross-tenant rows are remediated first (the triggers below
--    only protect future writes): a mismatched lead link is severed and
--    cross-tenant sub-agents are removed — such rows are corrupt by definition
--    and must not stay reachable from either tenant.
update public.departments d
   set main_agent_id = null
 where d.main_agent_id is not null
   and exists (select 1 from public.agents a where a.id = d.main_agent_id and a.account_id <> d.account_id);

delete from public.sub_agents s
 where exists (select 1 from public.departments d where d.id = s.department_id and d.account_id <> s.account_id);

create or replace function public.enforce_department_tenant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acc uuid;
begin
  if new.main_agent_id is null then
    return new;
  end if;
  select account_id into v_acc from public.agents where id = new.main_agent_id;
  if v_acc is null or v_acc <> new.account_id then
    raise exception 'department lead must belong to the department''s account' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_sub_agent_tenant()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_acc uuid;
begin
  select account_id into v_acc from public.departments where id = new.department_id;
  if v_acc is null or v_acc <> new.account_id then
    raise exception 'sub-agent department must belong to the sub-agent''s account' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists departments_tenant_guard on public.departments;
create trigger departments_tenant_guard
  before insert or update of main_agent_id, account_id on public.departments
  for each row execute function public.enforce_department_tenant();

drop trigger if exists sub_agents_tenant_guard on public.sub_agents;
create trigger sub_agents_tenant_guard
  before insert or update of department_id, account_id on public.sub_agents
  for each row execute function public.enforce_sub_agent_tenant();

-- 4) account-aware team retrieval. Both owner branches are independently
--    verified against p_account_id; unverified ids contribute nothing (fail
--    closed). The join on knowledge_docs makes the DOCUMENT's current owner the
--    source of truth, not the chunk's copied columns. match_knowledge (single
--    owner) is kept unchanged for rollout compatibility and rollback.
create or replace function public.match_knowledge_team(
  p_account_id uuid,
  p_agent_id uuid,
  p_department_id uuid,
  p_query vector(384),
  p_k int default 6
)
returns table(content text, similarity double precision)
language sql stable security definer set search_path = public as $$
  select c.content, 1 - (c.embedding <=> p_query) as similarity
  from public.knowledge_chunks c
  join public.knowledge_docs d on d.id = c.doc_id
  where c.embedding is not null
    and (
      (p_agent_id is not null and d.owner_type = 'agent' and d.owner_id = p_agent_id
        and exists (select 1 from public.agents a where a.id = p_agent_id and a.account_id = p_account_id))
      or
      (p_department_id is not null and d.owner_type = 'team' and d.owner_id = p_department_id
        and exists (select 1 from public.departments t where t.id = p_department_id and t.account_id = p_account_id))
    )
  order by c.embedding <=> p_query
  limit greatest(1, least(p_k, 20))
$$;

revoke all on function public.match_knowledge_team(uuid, uuid, uuid, vector, int) from public, anon, authenticated;
grant execute on function public.match_knowledge_team(uuid, uuid, uuid, vector, int) to service_role;

-- ─── 20260714110000_transcribe_jobs.sql ──────────────────────────────────────────────────────
-- Resumable long-audio transcription jobs (5-hour recordings).
-- Job state previously lived as JSON in the PUBLIC media bucket — partial
-- transcripts were reachable by URL and concurrent 'continue' calls could
-- double-transcribe and double-bill. This table is service-role only (RLS on,
-- no policies), claims are atomic (single conditional UPDATE with a lease),
-- and finalize is idempotent (status+billed_at guard: exactly one biller).
create table if not exists public.transcribe_jobs (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts(id) on delete cascade,
  user_id         uuid not null,
  file_name       text not null,           -- Gemini File API name (for cleanup)
  file_uri        text not null,           -- Gemini File API uri
  mime            text not null,
  language        text not null default 'auto',
  windows_done    int  not null default 0,
  max_windows     int  not null default 7, -- derived from validated duration; hard 5h bound
  transcript      text not null default '',
  provider_tokens bigint not null default 0,
  status          text not null default 'pending', -- pending | done | failed
  claimed_at      timestamptz,             -- 3-minute processing lease
  claim_token     uuid,                    -- proves lease OWNERSHIP: every write must match
  billed_at       timestamptz,             -- set exactly once by the finalizer
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists transcribe_jobs_account_idx on public.transcribe_jobs (account_id, created_at desc);

-- Service-role only: RLS enabled with NO anon/authenticated policies. The edge
-- function verifies the caller's account before touching a job.
alter table public.transcribe_jobs enable row level security;

-- Transactional finalize: verify the claim token, persist the final transcript,
-- record usage and decrement the balance IN ONE TRANSACTION, then mark the job
-- done+billed. Exactly one caller can win (status+billed_at+token guard); any
-- failure rolls back the whole finalize so it stays retryable — a job is never
-- marked billed unless usage and the balance change committed with it.
create or replace function public.finalize_transcribe_job(
  p_job_id uuid,
  p_account_id uuid,
  p_claim_token uuid,
  p_windows_done int,
  p_transcript text,
  p_provider_tokens bigint
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_billable bigint;
  v_updated integer;
begin
  if p_job_id is null or p_account_id is null or p_claim_token is null then
    raise exception 'finalize_transcribe_job: job, account and claim token are required' using errcode = '22004';
  end if;
  v_billable := greatest(coalesce(p_provider_tokens, 0), ceil(length(coalesce(p_transcript, ''))::numeric / 4)::bigint, 1);
  update public.transcribe_jobs
     set status = 'done',
         billed_at = now(),
         windows_done = p_windows_done,
         transcript = coalesce(p_transcript, ''),
         provider_tokens = coalesce(p_provider_tokens, 0),
         claimed_at = null,
         claim_token = null,
         updated_at = now()
   where id = p_job_id
     and account_id = p_account_id
     and status = 'pending'
     and billed_at is null
     and claim_token = p_claim_token;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return null; -- lost the race, stale token, or job already finished
  end if;
  insert into public.usage (account_id, tokens, model)
  values (p_account_id, v_billable, 'audio-transcription:gemini-file');
  -- usage stores RAW LLM tokens; the balance is charged in CREDITS through the
  -- existing converter (ceil(raw/1000)) so this path bills exactly like every
  -- other Edge Function — inside this transaction
  perform public.decrement_token_balance(p_account_id, v_billable);
  return v_billable;
end;
$$;

revoke all on function public.finalize_transcribe_job(uuid, uuid, uuid, int, text, bigint) from public, anon, authenticated;
grant execute on function public.finalize_transcribe_job(uuid, uuid, uuid, int, text, bigint) to service_role;

-- ─── 20260722120000_visual_rag_pilot.sql ─────────────────────────────────────────────────────
-- Visual RAG (PixelRAG/OCR) pilot — additive, feature-flagged OFF by default.
-- Clients can only SUBMIT (rate/size/concurrency-limited RPC) and READ their own
-- account's rows. All processing writes belong to the service-role worker. The
-- Qdrant contract is defense-in-depth: every point carries account_id in its
-- payload AND every query must filter by account_id.
create table if not exists public.visual_rag_jobs (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  created_by   uuid not null references auth.users(id) on delete cascade,
  source_path  text not null,
  source_bytes bigint not null check (source_bytes >= 1 and source_bytes <= 20971520),
  page_count   int not null check (page_count >= 1 and page_count <= 200),
  status       text not null default 'queued'
               check (status in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  result_path  text,
  error_code   text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);

-- Composite uniqueness lets page rows prove that their account_id belongs to
-- the same tenant as the parent job, even for service-role worker writes.
alter table public.visual_rag_jobs
  add constraint visual_rag_jobs_id_account_key unique (id, account_id);

create index if not exists visual_rag_jobs_account_idx
  on public.visual_rag_jobs (account_id, created_at desc);
-- fast "active jobs" count for the per-account concurrency gate
create index if not exists visual_rag_jobs_active_idx
  on public.visual_rag_jobs (account_id)
  where status in ('queued', 'processing');
-- fast oldest-queued claim
create index if not exists visual_rag_jobs_queued_idx
  on public.visual_rag_jobs (created_at)
  where status = 'queued';

create table if not exists public.visual_rag_pages (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null,
  account_id      uuid not null references public.accounts(id) on delete cascade,
  page_number     int not null check (page_number >= 1 and page_number <= 200),
  text_content    text,
  qdrant_point_id uuid,
  created_at      timestamptz not null default now(),
  unique (job_id, page_number),
  constraint visual_rag_pages_job_account_fk
    foreign key (job_id, account_id)
    references public.visual_rag_jobs(id, account_id) on delete cascade
);

create index if not exists visual_rag_pages_account_idx
  on public.visual_rag_pages (account_id, created_at desc);

-- RLS: members of the account may SELECT; there are NO client write policies.
-- The service-role worker bypasses RLS for processing writes.
alter table public.visual_rag_jobs enable row level security;
alter table public.visual_rag_pages enable row level security;

drop policy if exists visual_rag_jobs_select_acc on public.visual_rag_jobs;
create policy visual_rag_jobs_select_acc on public.visual_rag_jobs
  for select to authenticated
  using (account_id = public.current_account_id());

drop policy if exists visual_rag_pages_select_acc on public.visual_rag_pages;
create policy visual_rag_pages_select_acc on public.visual_rag_pages
  for select to authenticated
  using (account_id = public.current_account_id());

revoke all on public.visual_rag_jobs from public, anon, authenticated;
revoke all on public.visual_rag_pages from public, anon, authenticated;
grant select on public.visual_rag_jobs to authenticated;
grant select on public.visual_rag_pages to authenticated;

-- Submission gate. Derives the account from the caller (never accepts an
-- account_id argument), checks the feature flag, validates the storage path,
-- then serializes per-account limit checks with an advisory xact lock so
-- concurrent submissions cannot both pass the same limit window.
create or replace function public.submit_visual_rag_job(
  p_source_path text,
  p_source_bytes bigint,
  p_page_count int
)
returns setof public.visual_rag_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid;
  v_account   uuid;
  v_prefix    text;
  v_active    int;
  v_pages_24h bigint;
  v_subs_1m   int;
  v_job       public.visual_rag_jobs;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select u.account_id into v_account from public.users u where u.id = v_uid;
  if v_account is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if coalesce(current_setting('app.visual_rag_enabled', true), '') <> 'on' then
    raise exception 'feature_disabled';
  end if;

  -- normalized storage path: must live under <account>/visual-rag/ and cannot
  -- traverse ('..'), use backslashes, start with '/', or have an empty remainder
  if p_source_path is null
     or position('..' in p_source_path) > 0
     or position('\' in p_source_path) > 0
     or left(p_source_path, 1) = '/' then
    raise exception 'invalid_path';
  end if;
  v_prefix := v_account::text || '/visual-rag/';
  if left(p_source_path, length(v_prefix)) <> v_prefix
     or length(p_source_path) <= length(v_prefix) then
    raise exception 'invalid_path';
  end if;

  if p_source_bytes is null or p_source_bytes < 1 or p_source_bytes > 20971520 then
    raise exception 'invalid_size';
  end if;
  if p_page_count is null or p_page_count < 1 or p_page_count > 200 then
    raise exception 'invalid_pages';
  end if;

  -- serialize all limit checks per account
  perform pg_advisory_xact_lock(hashtextextended(v_account::text, 0));

  select count(*) into v_active
    from public.visual_rag_jobs
   where account_id = v_account and status in ('queued', 'processing');
  if v_active >= 2 then
    raise exception 'active_job_limit';
  end if;

  select coalesce(sum(page_count), 0) into v_pages_24h
    from public.visual_rag_jobs
   where account_id = v_account and created_at > now() - interval '24 hours';
  if v_pages_24h + p_page_count > 1000 then
    raise exception 'daily_page_limit';
  end if;

  select count(*) into v_subs_1m
    from public.visual_rag_jobs
   where account_id = v_account and created_at > now() - interval '1 minute';
  if v_subs_1m >= 30 then
    raise exception 'rate_limited';
  end if;

  insert into public.visual_rag_jobs (account_id, created_by, source_path, source_bytes, page_count)
  values (v_account, v_uid, p_source_path, p_source_bytes, p_page_count)
  returning * into v_job;
  return next v_job;
end;
$$;

revoke all on function public.submit_visual_rag_job(text, bigint, int) from public, anon;
grant execute on function public.submit_visual_rag_job(text, bigint, int) to authenticated;

-- Status read scoped to the caller's account (empty set on cross-tenant ids).
create or replace function public.get_visual_rag_job(p_job_id uuid)
returns setof public.visual_rag_jobs
language sql
security definer
set search_path = public
stable
as $$
  select j.*
    from public.visual_rag_jobs j
   where j.id = p_job_id
     and j.account_id = (select u.account_id from public.users u where u.id = auth.uid());
$$;

revoke all on function public.get_visual_rag_job(uuid) from public, anon;
grant execute on function public.get_visual_rag_job(uuid) to authenticated;

-- Worker claim: oldest queued job, SKIP LOCKED so parallel workers never
-- double-claim. The returned row carries id/account_id/source_path — the worker
-- payload contract (account_id must reach the Qdrant point payload).
create or replace function public.claim_visual_rag_job()
returns setof public.visual_rag_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.visual_rag_jobs j
     set status = 'processing', started_at = now()
   where j.id = (
     select q.id from public.visual_rag_jobs q
      where q.status = 'queued'
      order by q.created_at
      for update skip locked
      limit 1
   )
   returning j.*;
end;
$$;

revoke all on function public.claim_visual_rag_job() from public, anon, authenticated;
grant execute on function public.claim_visual_rag_job() to service_role;

-- Worker finalize: only a queued/processing job can finish, exactly once.
create or replace function public.finalize_visual_rag_job(
  p_job_id uuid,
  p_status text,
  p_result_path text default null,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid_status';
  end if;
  update public.visual_rag_jobs
     set status = p_status,
         result_path = p_result_path,
         error_code = p_error_code,
         completed_at = now()
   where id = p_job_id
     and status in ('queued', 'processing');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.finalize_visual_rag_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finalize_visual_rag_job(uuid, text, text, text) to service_role;

-- ─── 20260722170000_skill_review_pipeline.sql ────────────────────────────────────────────────
-- Governed custom-skill intake. Uploaded text is private by default; AI may only
-- nominate a shared candidate. A platform admin is required to publish it.
create table if not exists public.skill_submissions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_id uuid references public.agents(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  source_filename text check (char_length(source_filename) <= 180),
  content text not null check (char_length(content) between 1 and 12000),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'private' check (status in ('private','shared_candidate','shared','rejected')),
  compatibility_score smallint check (compatibility_score between 0 and 100),
  analysis jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists skill_submissions_account_created_idx on public.skill_submissions(account_id, created_at desc);
create index if not exists skill_submissions_shared_idx on public.skill_submissions(status, created_at desc) where status = 'shared';
create unique index if not exists skill_submissions_account_hash_uidx on public.skill_submissions(account_id, content_sha256);

alter table public.skill_submissions enable row level security;

drop policy if exists skill_submissions_read on public.skill_submissions;
create policy skill_submissions_read on public.skill_submissions for select to authenticated
  using (account_id = public.current_account_id() or status = 'shared');

-- Direct browser writes are deliberately denied. review-skill validates ownership,
-- treats content as untrusted data and writes with service_role after auth checks.
revoke insert, update, delete on public.skill_submissions from authenticated;
grant select on public.skill_submissions to authenticated;

comment on table public.skill_submissions is 'Private-by-default skill review queue; shared publication requires admin approval.';

-- ─── 20260723120000_business_profile_company_details.sql ─────────────────────────────────────
alter table public.business_profiles
  add column if not exists company_email text,
  add column if not exists employee_count text;

-- ─── 20260723121000_blocked_accounts_fail_closed.sql ─────────────────────────────────────────
create or replace function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.account_id
  from public.users u
  join public.accounts a on a.id = u.account_id
  where u.id = auth.uid()
    and coalesce(a.blocked, false) = false
$$;

-- ─── 20260723124500_assign_primary_super_admin.sql ───────────────────────────────────────────
update public.users
set is_admin = true
where lower(email) = 'redacted@invalid';

-- ─── 20260723143000_sub_agent_capability_skills.sql ──────────────────────────────────────────
-- Persist the exact capability methods assigned to every specialist.
-- RLS on sub_agents already scopes these rows to current_account_id().
alter table public.sub_agents
  add column if not exists skills jsonb not null default '[]'::jsonb;

alter table public.sub_agents
  drop constraint if exists sub_agents_skills_array;

alter table public.sub_agents
  add constraint sub_agents_skills_array
  check (jsonb_typeof(skills) = 'array');

-- ─── 20260723162000_provider_key_ciphertext_guard.sql ────────────────────────────────────────
-- Provider credentials may only enter the database through the server-side
-- connection functions. Existing legacy rows remain readable so they can be
-- rotated without an outage; every new or updated row must be ciphertext.

revoke insert, update, delete on public.provider_keys from anon, authenticated;

alter table public.provider_keys
  drop constraint if exists provider_keys_ciphertext_only;

alter table public.provider_keys
  add constraint provider_keys_ciphertext_only
  check (api_key ~ '^enc:v[12]:[^:]+:[^:]+$') not valid;

do $$
begin
  if not exists (
    select 1
    from public.provider_keys
    where api_key !~ '^enc:v[12]:[^:]+:[^:]+$'
  ) then
    alter table public.provider_keys
      validate constraint provider_keys_ciphertext_only;
  end if;
end
$$;

-- ─── 20260723183000_telegram_worker_reliability.sql ──────────────────────────────────────────
-- Make Telegram queueing atomic and make the worker lease self-healing.
-- A missing lease row previously made every worker invocation report that
-- another worker was draining, leaving voice messages unread forever.

create or replace function public.acquire_worker_lease(secs int default 60)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired boolean := false;
begin
  insert into public.worker_lease(id, locked_until)
  values (1, pg_catalog.now())
  on conflict (id) do nothing;

  update public.worker_lease
     set locked_until = pg_catalog.now() + pg_catalog.make_interval(secs => greatest(1, least(secs, 300)))
   where id = 1
     and locked_until <= pg_catalog.now()
  returning true into acquired;

  return coalesce(acquired, false);
end
$$;

create or replace function public.release_worker_lease()
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.worker_lease
     set locked_until = pg_catalog.now()
   where id = 1
  returning true
$$;

create or replace function public.enqueue_telegram_job(
  p_channel_id uuid,
  p_update_id bigint,
  p_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_rows integer := 0;
begin
  if p_channel_id is null or p_payload is null then
    raise exception 'invalid telegram queue payload';
  end if;

  if p_update_id is not null then
    insert into public.tg_updates(channel_id, update_id, created_at)
    values (p_channel_id, p_update_id, pg_catalog.now())
    on conflict (channel_id, update_id) do nothing;
    get diagnostics inserted_rows = row_count;
    if inserted_rows = 0 then
      return false;
    end if;
  end if;

  perform pgmq.send('tg_jobs', p_payload);
  return true;
end
$$;

revoke all on function public.acquire_worker_lease(int) from public, anon, authenticated;
revoke all on function public.release_worker_lease() from public, anon, authenticated;
revoke all on function public.enqueue_telegram_job(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.acquire_worker_lease(int) to service_role;
grant execute on function public.release_worker_lease() to service_role;
grant execute on function public.enqueue_telegram_job(uuid, bigint, jsonb) to service_role;

-- ─── 20260723193000_agent_stt_model.sql ──────────────────────────────────────────────────────
-- Explicit STT engine selection for Telegram voice transcription.
alter table public.agents
  add column if not exists stt_model text not null default 'auto';

alter table public.agents
  drop constraint if exists agents_stt_model_check;

alter table public.agents
  add constraint agents_stt_model_check
  check (stt_model in ('auto', 'ovozify-whisper-small-uz', 'gemini-openrouter'));

-- ─── 20260725120000_run_telemetry.sql ────────────────────────────────────────────────────────
-- Run telemetry (C0). Three separate holes made every cost and model-mix number unusable:
--
--   1. `usage.cost` was written by 4 of 22 call sites, so total spend read as ~$0.02 on 700k
--      tokens. Every other site inserted the row and left the column at its default.
--   2. `usage.model` is free text and 9 call sites wrote a PIPELINE LABEL into it
--      ('tool', 'media-image', 'research-agent', 'ops-workflow', 'subagent'…), so ~23% of
--      tokens were attributed to models that do not exist.
--   3. `research_runs.tokens` existed but was never set, so no run had a token count and
--      cost-per-run could not be derived at all.
--
-- This adds the missing columns and separates the two meanings. It does not invent costs for
-- historical rows: back-filling a price for a run whose model was never recorded would
-- manufacture exactly the kind of confident-but-wrong number this whole change exists to stop.

alter table public.usage add column if not exists stage   text;
alter table public.usage add column if not exists run_ref uuid;

-- A real model id always carries its provider prefix ("openai/gpt-4o"). Anything without one
-- was a stage label in the wrong column: move it, and stop counting it as a model.
update public.usage
   set stage = model,
       model = null
 where model is not null
   and model not like '%/%'
   and stage is null;

create index if not exists usage_run_ref_idx on public.usage (run_ref) where run_ref is not null;
create index if not exists usage_account_created_idx on public.usage (account_id, created_at desc);

alter table public.research_runs add column if not exists cost numeric not null default 0;

-- Dead-letter sweep for browser tasks. A `run` that comes back pending writes result='running'
-- and nothing ever revisits it: one such row has been running since 18 July. The watchdog
-- closes them out; this partial index keeps that sweep cheap.
create index if not exists tool_runs_pending_idx on public.tool_runs (tool, created_at)
  where result = 'running';

-- ─── 20260729110000_worker_lease_rls.sql ─────────────────────────────────────────────────────
-- The Telegram worker lease is infrastructure state, not browser-readable data.
-- RLS with no browser policies keeps the service-role worker functional while
-- preventing direct lease reads or writes from anon/authenticated clients.
alter table public.worker_lease enable row level security;
revoke all on table public.worker_lease from anon, authenticated;

-- ─── 20260730110000_queue_and_tenant_integrity.sql ───────────────────────────────────────────
-- Keep queue internals and server-generated agent state inaccessible to browser roles.
revoke all on function public.q_send(jsonb) from public, anon, authenticated;
revoke all on function public.q_read(int, int) from public, anon, authenticated;
revoke all on function public.q_delete(bigint) from public, anon, authenticated;
revoke all on function public.q_len() from public, anon, authenticated;
grant execute on function public.q_send(jsonb), public.q_read(int, int), public.q_delete(bigint), public.q_len() to service_role;

-- account_id must agree with every referenced agent and dialogue. RLS alone cannot
-- validate this because the referenced UUIDs are supplied by the caller.
create or replace function public.enforce_agent_memory_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.agents
    where id = new.agent_id and account_id = new.account_id
  ) then
    raise exception 'agent does not belong to memory account';
  end if;

  if new.dialogue_id is not null and not exists (
    select 1
    from public.dialogues d
    join public.agents a on a.id = d.agent_id
    where d.id = new.dialogue_id
      and d.agent_id = new.agent_id
      and a.account_id = new.account_id
  ) then
    raise exception 'dialogue does not belong to memory agent/account';
  end if;

  return new;
end
$$;

drop trigger if exists agent_memory_tenant_guard on public.agent_memory;
create trigger agent_memory_tenant_guard
before insert or update on public.agent_memory
for each row execute function public.enforce_agent_memory_tenant();
revoke all on function public.enforce_agent_memory_tenant() from public, anon, authenticated;
revoke insert, update, delete on public.agent_memory from anon, authenticated;

create or replace function public.enforce_agent_evolution_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.agents
    where id = new.agent_id and account_id = new.account_id
  ) then
    raise exception 'agent does not belong to evolution account';
  end if;

  return new;
end
$$;

drop trigger if exists agent_evolutions_tenant_guard on public.agent_evolutions;
create trigger agent_evolutions_tenant_guard
before insert or update on public.agent_evolutions
for each row execute function public.enforce_agent_evolution_tenant();
revoke all on function public.enforce_agent_evolution_tenant() from public, anon, authenticated;
revoke insert, update, delete on public.agent_evolutions from anon, authenticated;

-- ─── 20260801100000_ops_checks_admin_only.sql ────────────────────────────────────────────────
-- Platform health can expose operational topology. It is visible only to the
-- platform administrator, while the watchdog continues to write via service_role.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.users where id = auth.uid()), false);
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;

drop policy if exists ops_checks_read on public.ops_checks;
create policy ops_checks_read on public.ops_checks for select
  using (public.is_platform_admin());

-- ─── 20260803100000_browser_observations.sql ─────────────────────────────────────────────────
-- Extension snapshots are service-written only; pairing secrets are stored hashed.
create table if not exists public.browser_pairings (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  secret_hash text not null unique,
  active boolean not null default true,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.browser_observations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  pairing_id uuid not null references public.browser_pairings(id) on delete restrict,
  source_url text not null,
  page_title text not null default '',
  body_text text not null,
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists browser_observations_account_created_idx on public.browser_observations(account_id, created_at desc);
alter table public.browser_pairings enable row level security;
alter table public.browser_observations enable row level security;
revoke all on public.browser_pairings, public.browser_observations from anon, authenticated;

-- ─── 20260803110000_owner_approval_queue.sql ─────────────────────────────────────────────────
-- A decision record is separate from any executor. Approval alone never performs an action.
create table if not exists public.approval_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  source text not null check (source in ('browser', 'agent', 'workflow')),
  action_type text not null,
  summary text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists approval_requests_account_pending_idx on public.approval_requests(account_id, status, created_at desc);
alter table public.approval_requests enable row level security;
revoke all on public.approval_requests from anon, authenticated;

-- ─── 20260803120000_agent_action_policy.sql ──────────────────────────────────────────────────
-- Agents may either observe only or prepare an owner-approved draft.
-- An approved executor is intentionally not a valid value until an audited executor exists.
alter table public.agents add column if not exists action_policy text not null default 'approval_required';
alter table public.agents drop constraint if exists agents_action_policy_check;
alter table public.agents add constraint agents_action_policy_check check (action_policy in ('read_only', 'approval_required'));

-- ─── 20260803130000_mandatory_onboarding.sql ─────────────────────────────────────────────────
alter table public.business_profiles
  add column if not exists operating_markets text[] not null default '{}',
  add column if not exists owner_role text,
  add column if not exists primary_goal text,
  add column if not exists task_types text[] not null default '{}',
  add column if not exists data_sources text[] not null default '{}',
  add column if not exists default_action_policy text not null default 'approval_required';

alter table public.business_profiles drop constraint if exists business_profiles_action_policy_check;
alter table public.business_profiles add constraint business_profiles_action_policy_check
  check (default_action_policy in ('read_only', 'approval_required'));

drop policy if exists "Owners read onboarding business profile" on public.business_profiles;
create policy "Owners read onboarding business profile"
  on public.business_profiles for select
  to authenticated
  using (account_id = public.current_account_id());

create table if not exists public.user_consents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document text not null check (document in ('privacy', 'terms', 'marketing_email', 'marketing_telegram')),
  version text not null,
  granted boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists user_consents_account_user_idx on public.user_consents(account_id, user_id, created_at desc);
alter table public.user_consents enable row level security;
revoke all on public.user_consents from anon, authenticated;

-- ─── 20260803140000_atomic_agent_teams.sql ───────────────────────────────────────────────────
create or replace function public.create_agent_team(
  p_manager jsonb,
  p_department jsonb,
  p_specialists jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid := public.current_account_id();
  v_agent_id uuid;
  v_department_id uuid;
  v_specialist jsonb;
  v_name text := left(trim(coalesce(p_manager->>'name', '')), 60);
  v_policy text := coalesce(p_manager->>'action_policy', 'approval_required');
  v_risk text := coalesce(p_manager->>'risk_tier', 'standard');
  v_count integer;
begin
  if auth.uid() is null or v_account_id is null then
    raise exception using errcode = '42501', message = 'authenticated account required';
  end if;
  if jsonb_typeof(p_manager) <> 'object' or v_name = '' then
    raise exception using errcode = '22023', message = 'valid manager is required';
  end if;
  if jsonb_typeof(coalesce(p_manager->'prompt', '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'manager prompt must be an object';
  end if;
  if v_policy not in ('read_only', 'approval_required') then
    raise exception using errcode = '22023', message = 'invalid action policy';
  end if;
  if v_risk not in ('standard', 'regulated') then
    raise exception using errcode = '22023', message = 'invalid risk tier';
  end if;
  if jsonb_typeof(p_specialists) <> 'array' then
    raise exception using errcode = '22023', message = 'specialists must be an array';
  end if;
  v_count := jsonb_array_length(p_specialists);
  if v_count < 2 or v_count > 6 then
    raise exception using errcode = '22023', message = 'a team requires 2 to 6 specialists';
  end if;

  insert into public.agents (
    account_id, name, type, avatar_color, prompt, model, temperature, timezone,
    schedule, work_start, work_end, default_lang, country, purpose, niche,
    risk_tier, action_policy, template_key, status, lead_form, skills
  ) values (
    v_account_id,
    v_name,
    'workflow',
    left(coalesce(p_manager->>'avatar_color', 'violet'), 20),
    coalesce(p_manager->'prompt', '{}'::jsonb),
    left(coalesce(p_manager->>'model', 'openai/gpt-4o-mini'), 160),
    least(2, greatest(0, coalesce((p_manager->>'temperature')::numeric, 0.6))),
    left(coalesce(p_manager->>'timezone', 'Asia/Tashkent'), 80),
    case when p_manager->>'schedule' = 'work-hours' then 'work-hours' else '24/7' end,
    nullif(left(coalesce(p_manager->>'work_start', ''), 5), ''),
    nullif(left(coalesce(p_manager->>'work_end', ''), 5), ''),
    left(coalesce(p_manager->>'default_lang', 'auto'), 10),
    nullif(left(trim(coalesce(p_manager->>'country', '')), 120), ''),
    nullif(left(trim(coalesce(p_manager->>'purpose', '')), 500), ''),
    nullif(left(trim(coalesce(p_manager->>'niche', '')), 120), ''),
    v_risk,
    v_policy,
    nullif(left(trim(coalesce(p_manager->>'template_key', '')), 120), ''),
    'draft',
    coalesce(p_manager->'lead_form', '{}'::jsonb),
    case
      when jsonb_typeof(coalesce(p_manager->'skills', '[]'::jsonb)) = 'array'
      then array(select jsonb_array_elements_text(p_manager->'skills') limit 6)
      else '{}'::text[]
    end
  ) returning id into v_agent_id;

  insert into public.departments (account_id, main_agent_id, name, niche)
  values (
    v_account_id,
    v_agent_id,
    left(coalesce(nullif(trim(p_department->>'name'), ''), v_name), 60),
    nullif(left(trim(coalesce(p_department->>'niche', '')), 120), '')
  ) returning id into v_department_id;

  for v_specialist in select value from jsonb_array_elements(p_specialists)
  loop
    if jsonb_typeof(v_specialist) <> 'object'
      or trim(coalesce(v_specialist->>'role', '')) = ''
      or trim(coalesce(v_specialist->>'name', '')) = ''
      or jsonb_typeof(coalesce(v_specialist->'prompt', '{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(v_specialist->'skills', '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(v_specialist->'skills', '[]'::jsonb)) > 6
      or coalesce(v_specialist->>'status', 'active') not in ('active', 'paused') then
      raise exception using errcode = '22023', message = 'invalid specialist';
    end if;

    insert into public.sub_agents (
      account_id, department_id, role, name, prompt, skills, model, status
    ) values (
      v_account_id,
      v_department_id,
      left(trim(v_specialist->>'role'), 60),
      left(trim(v_specialist->>'name'), 60),
      v_specialist->'prompt',
      v_specialist->'skills',
      left(coalesce(v_specialist->>'model', 'openai/gpt-4o-mini'), 160),
      coalesce(v_specialist->>'status', 'active')
    );
  end loop;

  return jsonb_build_object('agent_id', v_agent_id, 'department_id', v_department_id, 'specialist_count', v_count);
end;
$$;

revoke all on function public.create_agent_team(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.create_agent_team(jsonb, jsonb, jsonb) to authenticated;

-- ─── 20260803150000_data_leakage_hardening.sql ───────────────────────────────────────────────
create table if not exists public.google_oauth_transactions (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  account_id uuid not null references public.accounts(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.google_oauth_transactions enable row level security;
revoke all on public.google_oauth_transactions from anon, authenticated;

create or replace function public.consume_google_oauth_transaction(p_state_hash text)
returns table(account_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.google_oauth_transactions
  set used_at = now()
  where state_hash = p_state_hash
    and used_at is null
    and expires_at > now()
  returning google_oauth_transactions.account_id;
$$;

revoke all on function public.consume_google_oauth_transaction(text) from public, anon, authenticated;
grant execute on function public.consume_google_oauth_transaction(text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'private-audio',
  'private-audio',
  false,
  188743680,
  array['audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/ogg','audio/webm','video/mp4','application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload own private audio" on storage.objects;
create policy "Users upload own private audio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'private-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = 'audio'
  );

alter table public.browser_observations
  add column if not exists expires_at timestamptz;

update public.browser_observations
set expires_at = least(coalesce(expires_at, created_at + interval '24 hours'), created_at + interval '24 hours')
where expires_at is null or expires_at > created_at + interval '24 hours';

alter table public.browser_observations
  alter column expires_at set default (now() + interval '24 hours'),
  alter column expires_at set not null;

create index if not exists browser_observations_expiry_idx on public.browser_observations(expires_at);

create or replace function public.purge_expired_browser_observations()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.browser_observations where expires_at <= now();
  delete from public.google_oauth_transactions where expires_at <= now() - interval '24 hours';
$$;

revoke all on function public.purge_expired_browser_observations() from public, anon, authenticated;
grant execute on function public.purge_expired_browser_observations() to service_role;

do $$
begin
  if exists(select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'nemo-private-data-retention';
    perform cron.schedule('nemo-private-data-retention', '17 * * * *', 'select public.purge_expired_browser_observations();');
  end if;
end;
$$;

-- ─── 20260803160000_production_test_account.sql ──────────────────────────────────────────────
alter table public.accounts
  add column if not exists is_production_e2e boolean not null default false;

create unique index if not exists accounts_single_production_e2e_idx
  on public.accounts ((1))
  where is_production_e2e;

revoke update(is_production_e2e) on public.accounts from anon, authenticated;

create or replace function public.guard_production_e2e_external_config()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  row_data jsonb := to_jsonb(new);
  target_account uuid;
begin
  if tg_table_name = 'channels' then
    select account_id into target_account from public.agents where id = (row_data->>'agent_id')::uuid;
  else
    target_account := nullif(row_data->>'account_id', '')::uuid;
  end if;

  if target_account is null or not exists(
    select 1 from public.accounts where id = target_account and is_production_e2e
  ) then
    return new;
  end if;

  if tg_table_name = 'channels' then
    if coalesce(row_data->'credentials', '{}'::jsonb) <> '{}'::jsonb
      or coalesce(row_data->>'secret_token', '') <> '' then
      raise exception using errcode = '42501', message = 'external credentials are disabled for the production test account';
    end if;
    return new;
  end if;

  if tg_table_name = 'business_profiles' then
    if coalesce(row_data->>'phone', '') <> ''
      or coalesce(row_data->>'notify_chat_id', '') <> ''
      or coalesce(row_data->>'tasks_sheet_id', '') <> ''
      or coalesce(row_data->>'planerka_members_sheet_id', '') <> '' then
      raise exception using errcode = '42501', message = 'external destinations are disabled for the production test account';
    end if;
    return new;
  end if;

  if tg_table_name = 'user_consents' then
    if row_data->>'document' in ('marketing_email', 'marketing_telegram') and (row_data->>'granted')::boolean then
      raise exception using errcode = '42501', message = 'marketing is disabled for the production test account';
    end if;
    return new;
  end if;

  raise exception using errcode = '42501', message = 'external configuration is disabled for the production test account';
end;
$$;

revoke all on function public.guard_production_e2e_external_config() from public, anon, authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'provider_keys', 'google_accounts', 'google_oauth_apps', 'social_accounts',
    'custom_tools', 'scheduled_posts', 'follow_ups', 'watched_sources',
    'channels', 'business_profiles', 'user_consents'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('drop trigger if exists production_e2e_external_config_guard on public.%I', table_name);
      execute format('create trigger production_e2e_external_config_guard before insert or update on public.%I for each row execute function public.guard_production_e2e_external_config()', table_name);
    end if;
  end loop;
end;
$$;

-- ─── 20260803170000_autonomous_run_checkpoints.sql ───────────────────────────────────────────
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

-- ─── 20260803180000_autonomous_run_worker.sql ────────────────────────────────────────────────
-- Claim-fenced durable execution for autonomous team runs. Browser roles never
-- receive direct table/RPC access; authenticated reads are mediated by orchestrate.
alter table public.autonomous_run_checkpoints
  add column if not exists transition text not null default 'staff',
  add column if not exists specialist_cursor integer not null default 0,
  add column if not exists review_cursor integer not null default 0,
  add column if not exists revision_round integer not null default 0,
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists last_error text,
  add column if not exists immutable_input jsonb not null default '{}'::jsonb;

alter table public.autonomous_run_checkpoints
  drop constraint if exists autonomous_run_checkpoints_status_check;
alter table public.autonomous_run_checkpoints
  add constraint autonomous_run_checkpoints_status_check
  check (status in ('active', 'queued', 'running', 'completed', 'failed', 'cancelled')) not valid;
alter table public.autonomous_run_checkpoints
  validate constraint autonomous_run_checkpoints_status_check;

alter table public.autonomous_run_checkpoints
  drop constraint if exists autonomous_run_checkpoints_transition_check;
alter table public.autonomous_run_checkpoints
  add constraint autonomous_run_checkpoints_transition_check
  check (transition in ('staff', 'specialist', 'review', 'revision', 'synth')) not valid;
alter table public.autonomous_run_checkpoints
  validate constraint autonomous_run_checkpoints_transition_check;

create index if not exists autonomous_run_worker_due_idx
  on public.autonomous_run_checkpoints (next_attempt_at, created_at)
  where status in ('queued', 'running');

create unique index if not exists autonomous_run_one_active_user_uidx
  on public.autonomous_run_checkpoints (account_id, user_id)
  where status in ('queued', 'running');

create or replace function public.claim_autonomous_run(p_lease_seconds integer default 600)
returns setof public.autonomous_run_checkpoints
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.autonomous_run_checkpoints;
begin
  with candidate as (
    select id
    from public.autonomous_run_checkpoints
    where expires_at > now()
      and attempt_count < 8
      and (
        (status = 'queued' and next_attempt_at <= now())
        or (status = 'running' and claimed_at < now() - make_interval(secs => greatest(60, least(p_lease_seconds, 1800))))
      )
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update public.autonomous_run_checkpoints r
  set status = 'running',
      claim_token = gen_random_uuid(),
      claimed_at = now(),
      attempt_count = r.attempt_count + 1,
      updated_at = now()
  from candidate
  where r.id = candidate.id
  returning r.* into claimed;

  if claimed.id is not null then return next claimed; end if;
end
$$;

create or replace function public.finish_autonomous_transition(
  p_run_id uuid,
  p_claim_token uuid,
  p_state jsonb,
  p_phase text,
  p_transition text,
  p_specialist_cursor integer,
  p_review_cursor integer,
  p_revision_round integer,
  p_status text default 'queued',
  p_last_error text default null,
  p_next_attempt_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('queued', 'completed', 'failed')
    or p_phase not in ('team', 'review', 'synth')
    or p_transition not in ('staff', 'specialist', 'review', 'revision', 'synth') then
    raise exception 'invalid autonomous transition';
  end if;

  update public.autonomous_run_checkpoints
  set state = p_state,
      phase = p_phase,
      transition = p_transition,
      specialist_cursor = greatest(0, p_specialist_cursor),
      review_cursor = greatest(0, p_review_cursor),
      revision_round = greatest(0, p_revision_round),
      status = p_status,
      attempt_count = case when p_last_error is null then 0 else attempt_count end,
      last_error = left(p_last_error, 2000),
      next_attempt_at = p_next_attempt_at,
      claim_token = null,
      claimed_at = null,
      updated_at = now()
  where id = p_run_id
    and status = 'running'
    and claim_token = p_claim_token;
  return found;
end
$$;

revoke all on function public.claim_autonomous_run(integer) from public, anon, authenticated;
revoke all on function public.finish_autonomous_transition(uuid,uuid,jsonb,text,text,integer,integer,integer,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_autonomous_run(integer) to service_role;
grant execute on function public.finish_autonomous_transition(uuid,uuid,jsonb,text,text,integer,integer,integer,text,text,timestamptz) to service_role;

-- ─── 20260804120000_idempotent_usage_accounting.sql ──────────────────────────────────────────
-- Usage and credit charging are one transaction. A worker retry reuses the
-- logical transition key, so it cannot insert or charge the same stage twice.
alter table public.usage add column if not exists billing_key text;

alter table public.usage
  drop constraint if exists usage_billing_key_length_check;
alter table public.usage
  add constraint usage_billing_key_length_check
  check (billing_key is null or length(billing_key) between 1 and 200) not valid;
alter table public.usage validate constraint usage_billing_key_length_check;

create unique index if not exists usage_account_billing_key_uidx
  on public.usage (account_id, billing_key)
  where billing_key is not null;

create or replace function public.record_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_tokens bigint,
  p_cost numeric,
  p_model text default null,
  p_stage text default null,
  p_run_ref uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_rows bigint;
begin
  if p_account_id is null
    or p_billing_key is null
    or length(p_billing_key) not between 1 and 200
    or p_tokens <= 0
    or p_cost < 0 then
    raise exception 'invalid usage accounting input';
  end if;

  insert into public.usage (account_id, billing_key, tokens, cost, model, stage, run_ref)
  values (p_account_id, p_billing_key, p_tokens, p_cost, p_model, p_stage, p_run_ref)
  on conflict (account_id, billing_key) where billing_key is not null do nothing;

  get diagnostics affected_rows = row_count;
  if affected_rows = 1 then
    update public.accounts
    set token_balance = greatest(0, token_balance - ceil(p_tokens / 1000.0)::bigint)
    where id = p_account_id;
    if not found then raise exception 'account not found'; end if;
  end if;

  return affected_rows = 1;
end
$$;

revoke all on function public.record_token_usage(uuid,text,bigint,numeric,text,text,uuid) from public, anon, authenticated;
grant execute on function public.record_token_usage(uuid,text,bigint,numeric,text,text,uuid) to service_role;

-- ─── 20260804130000_research_review_inbox.sql ────────────────────────────────────────────────
-- Team-quality escalation is owner work, not an external action, but it still
-- needs a durable inbox and an auditable decision. Keep the generated peer
-- review intact; store the owner's decision separately.
alter table public.research_runs
  add column if not exists human_review_status text,
  add column if not exists human_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists human_reviewed_at timestamptz;

alter table public.research_runs
  drop constraint if exists research_runs_human_review_status_check;
alter table public.research_runs
  add constraint research_runs_human_review_status_check
  check (human_review_status is null or human_review_status in ('pending', 'approved', 'rejected')) not valid;
alter table public.research_runs validate constraint research_runs_human_review_status_check;

alter table public.approval_requests
  add column if not exists related_research_run_id uuid references public.research_runs(id) on delete cascade;

alter table public.approval_requests
  drop constraint if exists approval_requests_related_research_run_id_fkey;
alter table public.approval_requests
  add constraint approval_requests_related_research_run_id_fkey
  foreign key (related_research_run_id) references public.research_runs(id) on delete set null;

-- Report creation remains available through existing RLS, but browser roles
-- cannot forge owner decisions or erase their audit trail.
revoke update, delete on public.research_runs from anon, authenticated;

create unique index if not exists approval_requests_research_review_uidx
  on public.approval_requests (account_id, related_research_run_id)
  where source = 'workflow' and action_type = 'research_quality_review';

create or replace function public.prepare_research_quality_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'needs_review' and new.human_review_status is null then
    new.human_review_status := 'pending';
  end if;
  return new;
end
$$;

create or replace function public.queue_research_quality_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  section_count integer;
begin
  if new.status <> 'needs_review' or new.human_review_status <> 'pending' then return new; end if;

  select count(*)::integer into section_count
  from jsonb_array_elements(case when jsonb_typeof(new.steps) = 'array' then new.steps else '[]'::jsonb end) step
  where coalesce((step->'review'->>'needs_human_review')::boolean, false);

  insert into public.approval_requests (
    account_id, source, action_type, summary, evidence, related_research_run_id, expires_at
  ) values (
    new.account_id,
    'workflow',
    'research_quality_review',
    left(new.task, 240),
    jsonb_build_object('research_run_id', new.id, 'run_ref', new.run_ref, 'sections', section_count),
    new.id,
    now() + interval '10 years'
  )
  on conflict (account_id, related_research_run_id)
    where source = 'workflow' and action_type = 'research_quality_review'
    do nothing;
  return new;
end
$$;

drop trigger if exists research_quality_review_prepare on public.research_runs;
create trigger research_quality_review_prepare
before insert or update of status on public.research_runs
for each row execute function public.prepare_research_quality_review();

drop trigger if exists research_quality_review_queue on public.research_runs;
create trigger research_quality_review_queue
after insert or update of status on public.research_runs
for each row execute function public.queue_research_quality_review();

create or replace function public.decide_approval_request(
  p_account_id uuid,
  p_user_id uuid,
  p_request_id uuid,
  p_decision text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.approval_requests;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'invalid decision'; end if;
  if not exists (
    select 1 from public.users where id = p_user_id and account_id = p_account_id
  ) then raise exception 'invalid owner context'; end if;

  select * into request_row
  from public.approval_requests
  where id = p_request_id and account_id = p_account_id and status = 'pending' and expires_at > now()
  for update;
  if not found then return false; end if;

  update public.approval_requests
  set status = p_decision, decided_by = p_user_id, decided_at = now()
  where id = request_row.id;

  if request_row.source = 'workflow'
    and request_row.action_type = 'research_quality_review'
    and request_row.related_research_run_id is not null then
    update public.research_runs
    set human_review_status = p_decision,
        human_reviewed_by = p_user_id,
        human_reviewed_at = now(),
        status = case when p_decision = 'approved' then 'done' else 'review_rejected' end
    where id = request_row.related_research_run_id
      and account_id = p_account_id
      and human_review_status = 'pending';
    if not found then raise exception 'research review is no longer pending'; end if;
  end if;

  return true;
end
$$;

revoke all on function public.decide_approval_request(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.decide_approval_request(uuid,uuid,uuid,text) to service_role;

-- Existing escalated reports must appear immediately after deployment.
update public.research_runs
set human_review_status = 'pending'
where status = 'needs_review' and human_review_status is null;

insert into public.approval_requests (
  account_id, source, action_type, summary, evidence, related_research_run_id, expires_at
)
select
  run.account_id,
  'workflow',
  'research_quality_review',
  left(run.task, 240),
  jsonb_build_object(
    'research_run_id', run.id,
    'run_ref', run.run_ref,
    'sections', (
      select count(*) from jsonb_array_elements(case when jsonb_typeof(run.steps) = 'array' then run.steps else '[]'::jsonb end) step
      where coalesce((step->'review'->>'needs_human_review')::boolean, false)
    )
  ),
  run.id,
  now() + interval '10 years'
from public.research_runs run
where run.status = 'needs_review' and run.human_review_status = 'pending'
on conflict (account_id, related_research_run_id)
  where source = 'workflow' and action_type = 'research_quality_review'
  do nothing;

-- ─── 20260804140000_token_usage_reservations.sql ─────────────────────────────────────────────
-- Reserve quota before concurrent provider calls, then atomically settle actual
-- usage and cache the logical action result for lost-response recovery.
create table if not exists public.token_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  billing_key text not null,
  run_id uuid not null,
  claim_token uuid not null,
  reserved_tokens bigint not null check (reserved_tokens > 0),
  reserved_credits bigint not null check (reserved_credits > 0),
  monthly_limit bigint not null check (monthly_limit > 0),
  status text not null default 'active' check (status in ('active', 'finalized', 'released', 'expired')),
  actual_tokens bigint,
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (account_id, billing_key)
);

alter table public.token_usage_reservations
  add column if not exists monthly_limit bigint;
alter table public.token_usage_reservations add column if not exists run_id uuid;
alter table public.token_usage_reservations add column if not exists claim_token uuid;
update public.token_usage_reservations set monthly_limit = 9223372036854775807 where monthly_limit is null;
alter table public.token_usage_reservations alter column monthly_limit set not null;

alter table public.token_usage_reservations enable row level security;
revoke all on public.token_usage_reservations from public, anon, authenticated;

create or replace function public.reserve_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_reserved_tokens bigint,
  p_monthly_limit bigint,
  p_run_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.token_usage_reservations;
  balance bigint;
  credits bigint;
  expired_credits bigint;
  used_tokens bigint;
  active_tokens bigint;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
begin
  if p_account_id is null or p_billing_key is null or length(p_billing_key) not between 1 and 200
    or p_reserved_tokens <= 0 or p_monthly_limit <= 0 then raise exception 'invalid reservation input'; end if;
  perform 1 from public.autonomous_run_checkpoints where id = p_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token for update;
  if not found then raise exception 'worker claim lost'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  select token_balance into balance from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  with released as (
    update public.token_usage_reservations
    set status = 'expired'
    where account_id = p_account_id and status = 'active' and expires_at <= now()
    returning reserved_credits
  ) select coalesce(sum(reserved_credits), 0) into expired_credits from released;
  balance := balance + expired_credits;
  if expired_credits > 0 then update public.accounts set token_balance = balance where id = p_account_id; end if;

  credits := ceil(p_reserved_tokens / 1000.0)::bigint;
  select coalesce(sum(tokens), 0) into used_tokens from public.usage
  where account_id = p_account_id and created_at >= month_start;
  select coalesce(sum(reserved_tokens), 0) into active_tokens from public.token_usage_reservations
  where account_id = p_account_id and status = 'active';

  if balance < credits then return jsonb_build_object('status', 'denied_balance'); end if;
  if used_tokens + active_tokens + p_reserved_tokens > p_monthly_limit then return jsonb_build_object('status', 'denied_quota'); end if;

  insert into public.token_usage_reservations(account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, expires_at)
  values (p_account_id, p_billing_key, p_run_id, p_claim_token, p_reserved_tokens, credits, p_monthly_limit, now() + interval '10 minutes')
  on conflict (account_id, billing_key) do update
    set reserved_tokens = excluded.reserved_tokens,
        reserved_credits = excluded.reserved_credits,
        monthly_limit = excluded.monthly_limit,
        run_id = excluded.run_id,
        claim_token = excluded.claim_token,
        status = 'active', result = null, actual_tokens = null,
        expires_at = excluded.expires_at, finalized_at = null;
  update public.accounts set token_balance = balance - credits where id = p_account_id;
  return jsonb_build_object('status', 'reserved');
end
$$;

create or replace function public.finalize_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_tokens bigint,
  p_cost numeric,
  p_model text,
  p_stage text,
  p_run_ref uuid,
  p_result jsonb,
  p_run_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.token_usage_reservations;
  actual_credits bigint;
begin
  -- Billing reflects provider work already performed. Cancellation or lease reclaim may
  -- stop state writes, but must not erase that external spend.
  perform 1 from public.autonomous_run_checkpoints where id = p_run_id and account_id = p_account_id for update;
  if not found then raise exception 'worker run not found'; end if;
  perform 1 from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;
  select * into reservation from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key for update;
  if not found then raise exception 'reservation not found'; end if;
  if reservation.run_id is distinct from p_run_id or reservation.claim_token is distinct from p_claim_token then
    raise exception 'reservation ownership mismatch';
  end if;
  if reservation.status = 'finalized' then return false; end if;
  if reservation.status <> 'active' or reservation.expires_at <= now() then raise exception 'reservation not active'; end if;
  if p_tokens <= 0 or p_cost < 0 then raise exception 'invalid actual usage'; end if;
  if p_result is null or octet_length(p_result::text) > 50000 then raise exception 'invalid cached result'; end if;

  actual_credits := ceil(p_tokens / 1000.0)::bigint;
  insert into public.usage(account_id, billing_key, tokens, cost, model, stage, run_ref)
  values(p_account_id, p_billing_key, p_tokens, p_cost, p_model, p_stage, p_run_ref);
  update public.accounts
  set token_balance = token_balance + reservation.reserved_credits - actual_credits
  where id = p_account_id;
  update public.token_usage_reservations
  set status = 'finalized', actual_tokens = p_tokens, result = p_result, finalized_at = now()
  where id = reservation.id;
  return true;
end
$$;

create or replace function public.complete_worker_from_research_run(
  p_worker_run_id uuid, p_claim_token uuid, p_account_id uuid, p_run_ref uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare existing public.research_runs;
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_worker_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  select * into existing from public.research_runs
  where account_id = p_account_id and run_ref = p_run_ref;
  if not found or existing.report is null then return false; end if;
  update public.autonomous_run_checkpoints
  set state = state || jsonb_build_object('result', existing.report, 'resultId', existing.id),
      phase = 'synth', transition = 'synth', status = 'completed',
      claim_token = null, claimed_at = null, last_error = null,
      next_attempt_at = now(), updated_at = now()
  where id = p_worker_run_id and claim_token = p_claim_token and status = 'running';
  return found;
end
$$;

drop function if exists public.release_token_usage(uuid, text);
create or replace function public.release_token_usage(
  p_account_id uuid, p_billing_key text, p_run_id uuid, p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare reservation public.token_usage_reservations;
begin
  perform 1 from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;
  select * into reservation from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key for update;
  if not found or reservation.status <> 'active' then return false; end if;
  if reservation.run_id is distinct from p_run_id or reservation.claim_token is distinct from p_claim_token then return false; end if;
  update public.accounts set token_balance = token_balance + reservation.reserved_credits where id = p_account_id;
  update public.token_usage_reservations set status = 'released', result = null where id = reservation.id;
  return true;
end
$$;

create or replace function public.record_worker_token_usage(
  p_run_id uuid, p_claim_token uuid, p_account_id uuid, p_billing_key text,
  p_tokens bigint, p_cost numeric, p_model text, p_stage text, p_run_ref uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  return public.record_token_usage(p_account_id, p_billing_key, p_tokens, p_cost, p_model, p_stage, p_run_ref);
end
$$;

create or replace function public.persist_worker_research_run(
  p_worker_run_id uuid, p_claim_token uuid, p_account_id uuid, p_task text,
  p_status text, p_department_id uuid, p_run_ref uuid, p_report text,
  p_sources jsonb, p_steps jsonb, p_model text, p_tokens bigint, p_cost numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare persisted_id uuid;
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_worker_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  insert into public.research_runs(account_id, task, status, kind, department_id, run_ref, report, sources, steps, model, tokens, cost)
  values(p_account_id, p_task, p_status, 'team_run', p_department_id, p_run_ref, p_report, p_sources, p_steps, p_model, p_tokens, p_cost)
  returning id into persisted_id;
  update public.autonomous_run_checkpoints
  set state = state || jsonb_build_object(
        'result', p_report,
        'resultId', persisted_id,
        'escalatedCount', (select count(*) from jsonb_array_elements(p_steps) step where coalesce((step->'review'->>'needs_human_review')::boolean, false))
      ),
      phase = 'synth', transition = 'synth', status = 'completed',
      specialist_cursor = jsonb_array_length(p_steps), review_cursor = jsonb_array_length(p_steps),
      claim_token = null, claimed_at = null, last_error = null,
      next_attempt_at = now(), updated_at = now()
  where id = p_worker_run_id and claim_token = p_claim_token and status = 'running';
  if not found then raise exception 'worker claim lost'; end if;
  return persisted_id;
end
$$;

revoke all on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) from public, anon, authenticated;
revoke all on function public.finalize_token_usage(uuid,text,bigint,numeric,text,text,uuid,jsonb,uuid,uuid) from public, anon, authenticated;
revoke all on function public.release_token_usage(uuid,text,uuid,uuid) from public, anon, authenticated;
revoke all on function public.record_worker_token_usage(uuid,uuid,uuid,text,bigint,numeric,text,text,uuid) from public, anon, authenticated;
revoke all on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) from public, anon, authenticated;
revoke all on function public.complete_worker_from_research_run(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) to service_role;
grant execute on function public.finalize_token_usage(uuid,text,bigint,numeric,text,text,uuid,jsonb,uuid,uuid) to service_role;
grant execute on function public.release_token_usage(uuid,text,uuid,uuid) to service_role;
grant execute on function public.record_worker_token_usage(uuid,uuid,uuid,text,bigint,numeric,text,text,uuid) to service_role;
grant execute on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) to service_role;
grant execute on function public.complete_worker_from_research_run(uuid,uuid,uuid,uuid) to service_role;

-- ─── 20260804150000_agent_eval_publish_gate.sql ──────────────────────────────────────────────
-- A published agent is an active agent whose exact configuration passed an
-- immutable sandbox evaluation. The database enforces this rather than trusting UI.
alter table public.agents
  add column if not exists config_revision bigint not null default 1 check (config_revision > 0),
  add column if not exists published_revision bigint,
  add column if not exists published_at timestamptz,
  add column if not exists latest_eval_run_id uuid;

alter table public.agents alter column status set default 'draft';
-- Existing live agents are explicitly grandfathered for a non-disruptive rollout.
-- Any behavior edit clears this marker and requires the normal eval/publish path.
update public.agents
set published_revision = config_revision, published_at = coalesce(published_at, now())
where status = 'active' and published_revision is null;

create table if not exists public.agent_eval_suites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  config_revision bigint not null check (config_revision > 0),
  suite_version integer not null default 1 check (suite_version > 0),
  cases jsonb not null check (jsonb_typeof(cases) = 'array' and jsonb_array_length(cases) between 3 and 12),
  generator_model text not null,
  generator_version text not null default 'deterministic-v1',
  created_at timestamptz not null default now(),
  unique (agent_id, config_revision, suite_version)
);

create table if not exists public.agent_eval_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  agent_id uuid not null references public.agents(id) on delete cascade,
  suite_id uuid not null references public.agent_eval_suites(id) on delete restrict,
  config_revision bigint not null check (config_revision > 0),
  status text not null check (status in ('running', 'passed', 'failed', 'error')),
  results jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  total_count integer not null default 0 check (total_count >= 0),
  passed_count integer not null default 0 check (passed_count >= 0),
  critical_failed_count integer not null default 0 check (critical_failed_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  runner_version text not null default 'sandbox-v1',
  judge_model text
);

create index if not exists agent_eval_suites_agent_revision_idx on public.agent_eval_suites(agent_id, config_revision, created_at desc);
create index if not exists agent_eval_runs_agent_revision_idx on public.agent_eval_runs(agent_id, config_revision, completed_at desc);
create unique index if not exists agent_eval_runs_one_active_account_uidx
  on public.agent_eval_runs(account_id) where status = 'running';

alter table public.agent_eval_suites enable row level security;
alter table public.agent_eval_runs enable row level security;
revoke all on public.agent_eval_suites, public.agent_eval_runs from public, anon, authenticated;
drop policy if exists agent_eval_suites_account_read on public.agent_eval_suites;
drop policy if exists agent_eval_runs_account_read on public.agent_eval_runs;
create policy agent_eval_suites_account_read on public.agent_eval_suites for select to authenticated using (account_id = public.current_account_id());
create policy agent_eval_runs_account_read on public.agent_eval_runs for select to authenticated using (account_id = public.current_account_id());

create or replace function public.invalidate_agent_publication()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(
    new.name, new.type, new.prompt, new.model, new.temperature, new.timezone,
    new.schedule, new.work_start, new.work_end, new.default_lang, new.country,
    new.purpose, new.niche, new.risk_tier, new.action_policy, new.voice_enabled,
    new.voice_mode, new.voice_id, new.stt_model, new.persona_mode, new.owner_name,
    new.skills, new.lead_form
  ) is distinct from row(
    old.name, old.type, old.prompt, old.model, old.temperature, old.timezone,
    old.schedule, old.work_start, old.work_end, old.default_lang, old.country,
    old.purpose, old.niche, old.risk_tier, old.action_policy, old.voice_enabled,
    old.voice_mode, old.voice_id, old.stt_model, old.persona_mode, old.owner_name,
    old.skills, old.lead_form
  ) then
    new.config_revision := old.config_revision + 1;
    new.published_revision := null;
    new.published_at := null;
    new.latest_eval_run_id := null;
    if old.status = 'active' then new.status := 'draft'; end if;
  end if;
  return new;
end
$$;

drop trigger if exists agents_invalidate_publication on public.agents;
create trigger agents_invalidate_publication
before update on public.agents
for each row execute function public.invalidate_agent_publication();

create or replace function public.require_passing_agent_eval()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    if current_setting('nemo.publish_authorized', true) is distinct from '1' then
      raise exception using errcode = '42501', message = 'AGENT_PUBLISH_OWNER_REQUIRED';
    end if;
    if not exists (
      select 1 from public.agent_eval_runs r
      where r.id = new.latest_eval_run_id
        and r.agent_id = new.id
        and r.account_id = new.account_id
        and r.config_revision = new.config_revision
        and r.status = 'passed'
        and r.critical_failed_count = 0
    ) then
      raise exception using errcode = '23514', message = 'AGENT_EVAL_REQUIRED';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists agents_require_passing_eval on public.agents;
create trigger agents_require_passing_eval
before insert or update of status on public.agents
for each row execute function public.require_passing_agent_eval();

create or replace function public.publish_agent(p_agent_id uuid, p_eval_run_id uuid)
returns public.agents
language plpgsql
security definer
set search_path = ''
as $$
declare v_agent public.agents; v_run public.agent_eval_runs;
begin
  select * into v_agent from public.agents where id = p_agent_id for update;
  if not found then raise exception 'agent not found'; end if;
  if not exists (select 1 from public.users where id = auth.uid() and account_id = v_agent.account_id and role = 'owner') then
    raise exception using errcode = '42501', message = 'owner required';
  end if;
  select * into v_run from public.agent_eval_runs where id = p_eval_run_id for update;
  if not found or v_run.account_id <> v_agent.account_id or v_run.agent_id <> v_agent.id
    or v_run.config_revision <> v_agent.config_revision or v_run.status <> 'passed' or v_run.critical_failed_count <> 0 then
    raise exception using errcode = '23514', message = 'AGENT_EVAL_REQUIRED';
  end if;
  perform set_config('nemo.publish_authorized', '1', true);
  update public.agents set status = 'active', published_revision = config_revision,
    published_at = now(), latest_eval_run_id = p_eval_run_id where id = v_agent.id
  returning * into v_agent;
  return v_agent;
end
$$;

revoke all on function public.publish_agent(uuid, uuid) from public, anon;
grant execute on function public.publish_agent(uuid, uuid) to authenticated;

-- ─── 20260804160000_team_draft_and_usage_aggregate.sql ───────────────────────────────────────
-- Repair production/source skew after the publish gate: atomic team creation must
-- create a draft manager, and token admission must aggregate without a row cap.
create or replace function public.create_agent_team(
  p_manager jsonb,
  p_department jsonb,
  p_specialists jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_account_id uuid := public.current_account_id();
  v_agent_id uuid;
  v_department_id uuid;
  v_specialist jsonb;
  v_name text := left(trim(coalesce(p_manager->>'name', '')), 60);
  v_policy text := coalesce(p_manager->>'action_policy', 'approval_required');
  v_risk text := coalesce(p_manager->>'risk_tier', 'standard');
  v_count integer;
begin
  if auth.uid() is null or v_account_id is null then
    raise exception using errcode = '42501', message = 'authenticated account required';
  end if;
  if jsonb_typeof(p_manager) <> 'object' or v_name = '' then
    raise exception using errcode = '22023', message = 'valid manager is required';
  end if;
  if jsonb_typeof(coalesce(p_manager->'prompt', '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'manager prompt must be an object';
  end if;
  if v_policy not in ('read_only', 'approval_required') then
    raise exception using errcode = '22023', message = 'invalid action policy';
  end if;
  if v_risk not in ('standard', 'regulated') then
    raise exception using errcode = '22023', message = 'invalid risk tier';
  end if;
  if jsonb_typeof(p_specialists) <> 'array' then
    raise exception using errcode = '22023', message = 'specialists must be an array';
  end if;
  v_count := jsonb_array_length(p_specialists);
  if v_count < 2 or v_count > 6 then
    raise exception using errcode = '22023', message = 'a team requires 2 to 6 specialists';
  end if;

  insert into public.agents (
    account_id, name, type, avatar_color, prompt, model, temperature, timezone,
    schedule, work_start, work_end, default_lang, country, purpose, niche,
    risk_tier, action_policy, template_key, status, lead_form, skills
  ) values (
    v_account_id,
    v_name,
    'workflow',
    left(coalesce(p_manager->>'avatar_color', 'violet'), 20),
    coalesce(p_manager->'prompt', '{}'::jsonb),
    left(coalesce(p_manager->>'model', 'openai/gpt-4o-mini'), 160),
    least(2, greatest(0, coalesce((p_manager->>'temperature')::numeric, 0.6))),
    left(coalesce(p_manager->>'timezone', 'Asia/Tashkent'), 80),
    case when p_manager->>'schedule' = 'work-hours' then 'work-hours' else '24/7' end,
    nullif(left(coalesce(p_manager->>'work_start', ''), 5), ''),
    nullif(left(coalesce(p_manager->>'work_end', ''), 5), ''),
    left(coalesce(p_manager->>'default_lang', 'auto'), 10),
    nullif(left(trim(coalesce(p_manager->>'country', '')), 120), ''),
    nullif(left(trim(coalesce(p_manager->>'purpose', '')), 500), ''),
    nullif(left(trim(coalesce(p_manager->>'niche', '')), 120), ''),
    v_risk,
    v_policy,
    nullif(left(trim(coalesce(p_manager->>'template_key', '')), 120), ''),
    'draft',
    coalesce(p_manager->'lead_form', '{}'::jsonb),
    case
      when jsonb_typeof(coalesce(p_manager->'skills', '[]'::jsonb)) = 'array'
      then array(select jsonb_array_elements_text(p_manager->'skills') limit 6)
      else '{}'::text[]
    end
  ) returning id into v_agent_id;

  insert into public.departments (account_id, main_agent_id, name, niche)
  values (
    v_account_id,
    v_agent_id,
    left(coalesce(nullif(trim(p_department->>'name'), ''), v_name), 60),
    nullif(left(trim(coalesce(p_department->>'niche', '')), 120), '')
  ) returning id into v_department_id;

  for v_specialist in select value from jsonb_array_elements(p_specialists)
  loop
    if jsonb_typeof(v_specialist) <> 'object'
      or trim(coalesce(v_specialist->>'role', '')) = ''
      or trim(coalesce(v_specialist->>'name', '')) = ''
      or jsonb_typeof(coalesce(v_specialist->'prompt', '{}'::jsonb)) <> 'object'
      or jsonb_typeof(coalesce(v_specialist->'skills', '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(v_specialist->'skills', '[]'::jsonb)) > 6
      or coalesce(v_specialist->>'status', 'active') not in ('active', 'paused') then
      raise exception using errcode = '22023', message = 'invalid specialist';
    end if;

    insert into public.sub_agents (
      account_id, department_id, role, name, prompt, skills, model, status
    ) values (
      v_account_id,
      v_department_id,
      left(trim(v_specialist->>'role'), 60),
      left(trim(v_specialist->>'name'), 60),
      v_specialist->'prompt',
      v_specialist->'skills',
      left(coalesce(v_specialist->>'model', 'openai/gpt-4o-mini'), 160),
      coalesce(v_specialist->>'status', 'active')
    );
  end loop;

  return jsonb_build_object('agent_id', v_agent_id, 'department_id', v_department_id, 'specialist_count', v_count);
end;
$$;

revoke all on function public.create_agent_team(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.create_agent_team(jsonb, jsonb, jsonb) to authenticated;

create or replace function public.monthly_token_usage(p_account_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(u.tokens), 0)::bigint
  from public.usage u
  where u.account_id = p_account_id
    and u.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
$$;

revoke all on function public.monthly_token_usage(uuid) from public, anon, authenticated;
grant execute on function public.monthly_token_usage(uuid) to service_role;

-- ─── 20260805090000_commerce_control_center.sql ──────────────────────────────────────────────
-- Uzum Ecommerce Control Center V1. Marketplace facts are append-only snapshots;
-- owner-maintained unit economics never come from the marketplace connector.
create table if not exists public.commerce_pilots (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'read_only', 'ended')),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  read_only_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > started_at)
);

create table if not exists public.commerce_catalogs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  source text not null check (source in ('uzum')),
  external_shop_id text not null check (external_shop_id ~ '^[0-9]{1,18}$'),
  name text not null check (char_length(name) between 1 and 120),
  timezone text not null default 'Asia/Tashkent' check (timezone = 'Asia/Tashkent'),
  status text not null default 'active' check (status in ('active', 'paused', 'no_access', 'error')),
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, source, external_shop_id)
);

create table if not exists public.commerce_skus (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.commerce_catalogs(id) on delete cascade,
  external_sku text not null check (char_length(external_sku) between 1 and 60),
  external_product_id text,
  title text not null check (char_length(title) between 1 and 160),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  lead_time_days integer check (lead_time_days between 0 and 365),
  moq integer check (moq between 1 and 10000000),
  safety_stock integer check (safety_stock >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  economics_revision bigint not null default 1 check (economics_revision > 0),
  economics_updated_at timestamptz,
  economics_updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (catalog_id, external_sku)
);

create table if not exists public.commerce_import_batches (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  catalog_id uuid not null references public.commerce_catalogs(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  file_name text not null check (char_length(file_name) between 1 and 180),
  file_sha256 text not null check (file_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'staged' check (status in ('staged', 'confirmed', 'rejected', 'failed')),
  total_rows integer not null default 0 check (total_rows >= 0),
  valid_rows integer not null default 0 check (valid_rows >= 0),
  unmatched_rows integer not null default 0 check (unmatched_rows >= 0),
  error_rows integer not null default 0 check (error_rows >= 0),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (valid_rows + error_rows <= total_rows),
  unique (account_id, catalog_id, file_sha256)
);

create table if not exists public.commerce_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.commerce_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),
  external_sku text,
  matched_sku_id uuid references public.commerce_skus(id) on delete set null,
  match_status text not null check (match_status in ('matched', 'unmatched', 'invalid', 'confirmed')),
  errors jsonb not null default '[]'::jsonb check (jsonb_typeof(errors) = 'array'),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  lead_time_days integer check (lead_time_days between 0 and 365),
  moq integer check (moq between 1 and 10000000),
  safety_stock integer check (safety_stock >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  created_at timestamptz not null default now(),
  unique (batch_id, row_number)
);

create table if not exists public.commerce_sync_runs (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid not null references public.commerce_catalogs(id) on delete cascade,
  scheduled_for timestamptz not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'skipped')),
  claim_token uuid,
  claimed_at timestamptz,
  completed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (catalog_id, scheduled_for)
);

create table if not exists public.commerce_inventory_snapshots (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.commerce_skus(id) on delete cascade,
  sync_run_id uuid not null references public.commerce_sync_runs(id) on delete restrict,
  observed_slot timestamptz not null,
  observed_at timestamptz not null default now(),
  price_tiyin bigint check (price_tiyin >= 0),
  stock_total integer check (stock_total >= 0),
  stock_fbo integer check (stock_fbo >= 0),
  stock_fbs integer check (stock_fbs >= 0),
  sold_units_7d integer check (sold_units_7d >= 0),
  source jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object'),
  created_at timestamptz not null default now(),
  unique (sku_id, observed_slot)
);

create table if not exists public.commerce_recommendations (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.commerce_skus(id) on delete cascade,
  snapshot_id uuid not null references public.commerce_inventory_snapshots(id) on delete restrict,
  kind text not null check (kind in ('reorder', 'price_guard', 'missing_data')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open' check (status in ('open', 'dismissed', 'accepted', 'expired')),
  dedupe_key text not null unique check (char_length(dedupe_key) between 1 and 180),
  economics_revision bigint not null,
  calculation jsonb not null check (jsonb_typeof(calculation) = 'object'),
  suggested_action jsonb not null default '{}'::jsonb check (jsonb_typeof(suggested_action) = 'object'),
  approval_request_id uuid references public.approval_requests(id) on delete set null,
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists commerce_catalogs_account_idx on public.commerce_catalogs(account_id, status);
create index if not exists commerce_skus_catalog_idx on public.commerce_skus(catalog_id);
create index if not exists commerce_import_batches_catalog_idx on public.commerce_import_batches(catalog_id, created_at desc);
create index if not exists commerce_import_rows_batch_status_idx on public.commerce_import_rows(batch_id, match_status);
create index if not exists commerce_sync_runs_due_idx on public.commerce_sync_runs(status, scheduled_for);
create index if not exists commerce_inventory_snapshots_sku_slot_idx on public.commerce_inventory_snapshots(sku_id, observed_slot desc);
create index if not exists commerce_recommendations_sku_status_idx on public.commerce_recommendations(sku_id, status, severity);

create or replace function public.commerce_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists commerce_catalogs_touch on public.commerce_catalogs;
create trigger commerce_catalogs_touch before update on public.commerce_catalogs
for each row execute function public.commerce_touch_updated_at();
drop trigger if exists commerce_skus_touch on public.commerce_skus;
create trigger commerce_skus_touch before update on public.commerce_skus
for each row execute function public.commerce_touch_updated_at();
drop trigger if exists commerce_recommendations_touch on public.commerce_recommendations;
create trigger commerce_recommendations_touch before update on public.commerce_recommendations
for each row execute function public.commerce_touch_updated_at();

alter table public.commerce_pilots enable row level security;
alter table public.commerce_catalogs enable row level security;
alter table public.commerce_skus enable row level security;
alter table public.commerce_import_batches enable row level security;
alter table public.commerce_import_rows enable row level security;
alter table public.commerce_sync_runs enable row level security;
alter table public.commerce_inventory_snapshots enable row level security;
alter table public.commerce_recommendations enable row level security;

revoke all on public.commerce_pilots, public.commerce_catalogs, public.commerce_skus,
  public.commerce_import_batches, public.commerce_import_rows, public.commerce_sync_runs,
  public.commerce_inventory_snapshots, public.commerce_recommendations from public, anon, authenticated;
grant select on public.commerce_pilots, public.commerce_catalogs, public.commerce_skus,
  public.commerce_import_batches, public.commerce_import_rows, public.commerce_inventory_snapshots,
  public.commerce_recommendations to authenticated;

create policy commerce_pilots_account_read on public.commerce_pilots for select to authenticated
  using (account_id = public.current_account_id());
create policy commerce_catalogs_account_read on public.commerce_catalogs for select to authenticated
  using (account_id = public.current_account_id());
create policy commerce_skus_account_read on public.commerce_skus for select to authenticated
  using (exists (select 1 from public.commerce_catalogs c where c.id = catalog_id and c.account_id = public.current_account_id()));
create policy commerce_import_batches_account_read on public.commerce_import_batches for select to authenticated
  using (account_id = public.current_account_id());
create policy commerce_import_rows_account_read on public.commerce_import_rows for select to authenticated
  using (exists (select 1 from public.commerce_import_batches b where b.id = batch_id and b.account_id = public.current_account_id()));
create policy commerce_inventory_snapshots_account_read on public.commerce_inventory_snapshots for select to authenticated
  using (exists (
    select 1 from public.commerce_skus s join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = sku_id and c.account_id = public.current_account_id()
  ));
create policy commerce_recommendations_account_read on public.commerce_recommendations for select to authenticated
  using (exists (
    select 1 from public.commerce_skus s join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = sku_id and c.account_id = public.current_account_id()
  ));

create or replace function public.confirm_commerce_import(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.commerce_import_batches;
  v_user_id uuid := auth.uid();
  v_row public.commerce_import_rows;
  v_applied integer := 0;
begin
  select * into v_batch from public.commerce_import_batches where id = p_batch_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'commerce import not found'; end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_user_id and u.account_id = v_batch.account_id and u.role = 'owner'
  ) then
    raise exception using errcode = '42501', message = 'owner required';
  end if;
  if v_batch.status <> 'staged' then
    raise exception using errcode = '23514', message = 'commerce import is not staged';
  end if;

  for v_row in
    select * from public.commerce_import_rows
    where batch_id = v_batch.id and match_status in ('matched', 'confirmed') and jsonb_array_length(errors) = 0
    order by row_number
  loop
    if not exists (select 1 from public.commerce_skus s where s.id = v_row.matched_sku_id and s.catalog_id = v_batch.catalog_id) then
      raise exception using errcode = '42501', message = 'import row references a foreign SKU';
    end if;
    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_row.unit_cost_tiyin, s.unit_cost_tiyin),
      commission_percent = coalesce(v_row.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_row.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_row.returns_reserve_percent, s.returns_reserve_percent),
      lead_time_days = coalesce(v_row.lead_time_days, s.lead_time_days),
      moq = coalesce(v_row.moq, s.moq),
      safety_stock = coalesce(v_row.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_row.min_margin_percent, s.min_margin_percent),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now(),
      economics_updated_by = v_user_id
    where s.id = v_row.matched_sku_id;
    update public.commerce_import_rows set match_status = 'confirmed' where id = v_row.id;
    v_applied := v_applied + 1;
  end loop;

  update public.commerce_import_batches
  set status = 'confirmed', confirmed_at = now(), confirmed_by = v_user_id
  where id = v_batch.id;
  return jsonb_build_object('batch_id', v_batch.id, 'applied_rows', v_applied);
end
$$;

revoke all on function public.confirm_commerce_import(uuid) from public, anon;
grant execute on function public.confirm_commerce_import(uuid) to authenticated;

create or replace function public.claim_commerce_sync_runs(p_limit integer default 20)
returns setof public.commerce_sync_runs
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select r.id
    from public.commerce_sync_runs r
    join public.commerce_catalogs c on c.id = r.catalog_id
    join public.commerce_pilots p on p.account_id = c.account_id
    where r.scheduled_for <= now()
      and p.status = 'active'
      and p.expires_at > now()
      and c.status = 'active'
      and (r.status = 'queued' or (r.status = 'running' and r.claimed_at < now() - interval '10 minutes'))
    order by r.scheduled_for
    limit least(greatest(p_limit, 1), 50)
    for update of r skip locked
  )
  update public.commerce_sync_runs r
  set status = 'running', claim_token = gen_random_uuid(), claimed_at = now(), error = null
  from due
  where r.id = due.id
  returning r.*;
end
$$;

revoke all on function public.claim_commerce_sync_runs(integer) from public, anon, authenticated;
grant execute on function public.claim_commerce_sync_runs(integer) to service_role;

-- ─── 20260805100000_commerce_alert_delivery.sql ──────────────────────────────────────────────
alter table public.commerce_recommendations
  add column if not exists alerted_at timestamptz,
  add column if not exists digest_sent_at date;

create index if not exists commerce_recommendations_critical_unsent_idx
  on public.commerce_recommendations(created_at)
  where severity = 'critical' and alerted_at is null and status = 'open';

-- ─── 20260805110000_commerce_telegram_links.sql ──────────────────────────────────────────────
-- Short-lived deep-link tokens bind an owner chat without exposing Telegram IDs in URLs.
create table if not exists public.commerce_telegram_links (
  token uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.commerce_telegram_links enable row level security;
revoke all on public.commerce_telegram_links from public, anon, authenticated;

-- ─── 20260805120000_commerce_economics_autofill.sql ──────────────────────────────────────────
-- Owner-triggered economics estimates. Every estimated value is provenance-tracked per
-- field in commerce_skus.estimated_fields; recommendations computed from estimates are
-- capped at 'warning' severity, so critical Telegram alerts only ever fire from
-- owner-confirmed numbers. Estimates are never invented silently: only an explicit
-- owner action writes them, and any manual edit of a field removes its estimate mark.
alter table public.commerce_skus
  add column if not exists estimated_fields jsonb not null default '[]'::jsonb
  check (jsonb_typeof(estimated_fields) = 'array');

create or replace function public.autofill_commerce_economics(p_catalog_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_account uuid;
  v_run_id uuid;
  v_cost integer := 0;
  v_supply integer := 0;
begin
  select account_id into v_account from public.commerce_catalogs where id = p_catalog_id;
  if v_account is null then
    raise exception using errcode = 'P0002', message = 'commerce catalog not found';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = v_user_id and u.account_id = v_account and u.role = 'owner'
  ) then
    raise exception using errcode = '42501', message = 'owner required';
  end if;

  select id into v_run_id from public.commerce_sync_runs
  where catalog_id = p_catalog_id and status = 'completed'
  order by scheduled_for desc limit 1;
  if v_run_id is null then
    raise exception using errcode = '23514', message = 'no completed sync yet';
  end if;

  -- Cost estimate: 50% of the latest observed retail price. Only fills SKUs the owner
  -- has never priced, and is always marked as an estimate.
  with latest as (
    select n.sku_id, n.price_tiyin
    from public.commerce_inventory_snapshots n
    where n.sync_run_id = v_run_id
  )
  update public.commerce_skus s
  set unit_cost_tiyin = l.price_tiyin / 2,
      estimated_fields = s.estimated_fields || '["unit_cost_tiyin"]'::jsonb,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now(),
      economics_updated_by = v_user_id
  from latest l
  where s.id = l.sku_id and s.catalog_id = p_catalog_id
    and s.unit_cost_tiyin is null and l.price_tiyin > 0
    and not s.estimated_fields ? 'unit_cost_tiyin';
  get diagnostics v_cost = row_count;

  -- Supply estimate: 15-day lead time, zero safety stock. Enables the reorder planner;
  -- reorder alerts stay non-critical until the owner confirms these numbers.
  update public.commerce_skus s
  set lead_time_days = coalesce(s.lead_time_days, 15),
      safety_stock = coalesce(s.safety_stock, 0),
      estimated_fields = s.estimated_fields
        || case when s.lead_time_days is null then '["lead_time_days"]'::jsonb else '[]'::jsonb end
        || case when s.safety_stock is null then '["safety_stock"]'::jsonb else '[]'::jsonb end,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now(),
      economics_updated_by = v_user_id
  where s.catalog_id = p_catalog_id and (s.lead_time_days is null or s.safety_stock is null);
  get diagnostics v_supply = row_count;

  return jsonb_build_object('cost_estimated', v_cost, 'supply_estimated', v_supply);
end
$$;

revoke all on function public.autofill_commerce_economics(uuid) from public, anon;
grant execute on function public.autofill_commerce_economics(uuid) to authenticated;

-- ─── 20260805130000_commerce_notify_channel.sql ──────────────────────────────────────────────
-- An account can have several connected Telegram bots. Storing only notify_chat_id left the
-- sender ambiguous: a digest could go out through a bot the owner never started a chat with,
-- which Telegram rejects, so nothing arrived and no delivery was recorded. Bind the chat to the
-- exact channel that received /start, and record which bot issued each deep link.
alter table public.business_profiles
  add column if not exists notify_channel_id uuid references public.channels(id) on delete set null;

alter table public.commerce_telegram_links
  add column if not exists channel_id uuid references public.channels(id) on delete set null;

-- ─── 20260805140000_commerce_economics_proposals.sql ─────────────────────────────────────────
-- Telegram economics input is a proposal, never a write. The bot parses what the owner said,
-- stores it here as 'pending', and only an explicit Yes press moves the numbers into
-- commerce_skus. Voice transcription and LLM extraction can both be wrong, so nothing touches
-- money until a human confirms the exact parsed values shown back to them.
create table if not exists public.commerce_economics_proposals (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  chat_id text not null check (char_length(chat_id) between 1 and 40),
  sku_id uuid references public.commerce_skus(id) on delete cascade,
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  product_query text not null check (char_length(product_query) between 1 and 200),
  source_text text not null check (char_length(source_text) between 1 and 2000),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  lead_time_days integer check (lead_time_days between 0 and 365),
  safety_stock integer check (safety_stock >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'expired')),
  expires_at timestamptz not null default (now() + interval '1 hour'),
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  -- A proposal that changes nothing is not worth confirming.
  check (unit_cost_tiyin is not null or lead_time_days is not null or safety_stock is not null or min_margin_percent is not null)
);

create index if not exists commerce_economics_proposals_chat_idx
  on public.commerce_economics_proposals(chat_id, status, created_at desc);

alter table public.commerce_economics_proposals enable row level security;
revoke all on public.commerce_economics_proposals from public, anon, authenticated;
grant select on public.commerce_economics_proposals to authenticated;
create policy commerce_economics_proposals_account_read on public.commerce_economics_proposals for select to authenticated
  using (account_id = public.current_account_id());

-- Applying a proposal is the same contract as an owner edit in the UI: the confirmed fields stop
-- being estimates and the revision advances so recommendations recompute against real numbers.
create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;
  if v_proposal.sku_id is null then
    raise exception using errcode = '23514', message = 'proposal has no resolved SKU';
  end if;
  -- The SKU must still belong to the proposing account.
  if not exists (
    select 1 from public.commerce_skus s
    join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
  ) then
    raise exception using errcode = '42501', message = 'SKU does not belong to this account';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := v_applied || 'unit_cost_tiyin'; end if;
  if v_proposal.lead_time_days is not null then v_applied := v_applied || 'lead_time_days'; end if;
  if v_proposal.safety_stock is not null then v_applied := v_applied || 'safety_stock'; end if;
  if v_proposal.min_margin_percent is not null then v_applied := v_applied || 'min_margin_percent'; end if;

  select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
  from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
  where field <> all (v_applied);

  update public.commerce_skus s set
    unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
    lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
    safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
    min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
    estimated_fields = v_estimated,
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = v_proposal.sku_id;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object('sku_id', v_proposal.sku_id, 'applied_fields', to_jsonb(v_applied));
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;

-- ─── 20260805150000_fix_proposal_applied_fields.sql ──────────────────────────────────────────
-- `v_applied || 'unit_cost_tiyin'` looks like an append but Postgres resolves the untyped literal
-- against anyarray||anyarray and fails with "malformed array literal" at runtime. Function
-- creation does not catch it, so every Yes press failed in production while the SQL looked fine.
-- array_append is unambiguous.
create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;
  if v_proposal.sku_id is null then
    raise exception using errcode = '23514', message = 'proposal has no resolved SKU';
  end if;
  if not exists (
    select 1 from public.commerce_skus s
    join public.commerce_catalogs c on c.id = s.catalog_id
    where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
  ) then
    raise exception using errcode = '42501', message = 'SKU does not belong to this account';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;

  select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
  from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
  where field <> all (v_applied);

  update public.commerce_skus s set
    unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
    lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
    safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
    min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
    estimated_fields = v_estimated,
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = v_proposal.sku_id;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object('sku_id', v_proposal.sku_id, 'applied_fields', to_jsonb(v_applied));
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;

-- ─── 20260805160000_commerce_fee_proposals.sql ───────────────────────────────────────────────
-- Uzum's seller API does not expose commission, fulfillment or the returns reserve, so
-- Price Guard cannot compute a margin at all today. Those three numbers live in the seller
-- cabinet, which the read-only browser extension can already observe. This lets an
-- observation become a proposal — never a write — and lets one proposal target a whole
-- catalogue, because a seller's fees are an account-level fact, not a per-SKU one.
alter table public.commerce_economics_proposals
  add column if not exists commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  add column if not exists fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  add column if not exists returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  add column if not exists catalog_id uuid references public.commerce_catalogs(id) on delete cascade,
  add column if not exists source text not null default 'telegram'
    check (source in ('telegram', 'browser', 'ui'));

-- A browser or UI proposal has no chat behind it.
alter table public.commerce_economics_proposals alter column channel_id drop not null;
alter table public.commerce_economics_proposals alter column chat_id drop not null;

alter table public.commerce_economics_proposals
  drop constraint if exists commerce_economics_proposals_check;

alter table public.commerce_economics_proposals
  add constraint commerce_economics_proposals_target_check
  check (sku_id is not null or catalog_id is not null);

alter table public.commerce_economics_proposals
  add constraint commerce_economics_proposals_value_check
  check (
    unit_cost_tiyin is not null or lead_time_days is not null or safety_stock is not null
    or min_margin_percent is not null or commission_percent is not null
    or fulfillment_tiyin is not null or returns_reserve_percent is not null
  );

-- A telegram proposal must still carry the chat it came from, or the callback handler
-- could not verify who is allowed to press the button.
alter table public.commerce_economics_proposals
  add constraint commerce_economics_proposals_telegram_check
  check (source <> 'telegram' or (channel_id is not null and chat_id is not null));

create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
  v_touched integer := 0;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;
  if v_proposal.commission_percent is not null then v_applied := array_append(v_applied, 'commission_percent'); end if;
  if v_proposal.fulfillment_tiyin is not null then v_applied := array_append(v_applied, 'fulfillment_tiyin'); end if;
  if v_proposal.returns_reserve_percent is not null then v_applied := array_append(v_applied, 'returns_reserve_percent'); end if;

  if v_proposal.sku_id is not null then
    -- Single SKU: the owner named this product, so its values are overwritten.
    if not exists (
      select 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
      where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'SKU does not belong to this account';
    end if;

    select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
    from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
    where field <> all (v_applied);

    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
      lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
      safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
      commission_percent = coalesce(v_proposal.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, s.returns_reserve_percent),
      estimated_fields = v_estimated,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.id = v_proposal.sku_id;
    v_touched := 1;
  else
    if not exists (
      select 1 from public.commerce_catalogs c
      where c.id = v_proposal.catalog_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'catalogue does not belong to this account';
    end if;

    -- Catalogue-wide fees only FILL BLANKS. A seller who already typed a real commission for
    -- one product must not have it silently replaced by a number scraped off a fees page.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
      );
    get diagnostics v_touched = row_count;
  end if;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object(
    'sku_id', v_proposal.sku_id,
    'catalog_id', v_proposal.catalog_id,
    'applied_fields', to_jsonb(v_applied),
    'skus_touched', v_touched
  );
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;

-- ─── 20260806150000_commerce_catalog_min_margin.sql ──────────────────────────────────────────
-- Minimum margin is the last field Price Guard needs and the only one no source can supply:
-- not the Uzum API, not the seller cabinet, not the browser extension. It is a decision about
-- how much the seller is willing to earn. Setting it per SKU across a 113-product catalogue is
-- busywork, so a catalogue-wide proposal covers it in one confirmation.
create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
  v_touched integer := 0;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;
  if v_proposal.commission_percent is not null then v_applied := array_append(v_applied, 'commission_percent'); end if;
  if v_proposal.fulfillment_tiyin is not null then v_applied := array_append(v_applied, 'fulfillment_tiyin'); end if;
  if v_proposal.returns_reserve_percent is not null then v_applied := array_append(v_applied, 'returns_reserve_percent'); end if;

  if v_proposal.sku_id is not null then
    if not exists (
      select 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
      where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'SKU does not belong to this account';
    end if;

    select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
    from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
    where field <> all (v_applied);

    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
      lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
      safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
      commission_percent = coalesce(v_proposal.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, s.returns_reserve_percent),
      estimated_fields = v_estimated,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.id = v_proposal.sku_id;
    v_touched := 1;
  else
    if not exists (
      select 1 from public.commerce_catalogs c
      where c.id = v_proposal.catalog_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'catalogue does not belong to this account';
    end if;

    -- Catalogue-wide values only FILL BLANKS, minimum margin included. A seller who set 30% on
    -- one product must not have it flattened to the catalogue default; a bulk convenience must
    -- never quietly overwrite a deliberate per-product decision.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      min_margin_percent = coalesce(s.min_margin_percent, v_proposal.min_margin_percent),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
        or (v_proposal.min_margin_percent is not null and s.min_margin_percent is null)
      );
    get diagnostics v_touched = row_count;
  end if;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object(
    'sku_id', v_proposal.sku_id,
    'catalog_id', v_proposal.catalog_id,
    'applied_fields', to_jsonb(v_applied),
    'skus_touched', v_touched
  );
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;

-- ─── 20260806160000_commerce_catalog_defaults.sql ────────────────────────────────────────────
-- Economics defaults belong to the catalogue, not to a one-time bulk update of its products.
--
-- Until now a seller set a 20% margin, the catalogue grew, and every product added afterwards
-- arrived with empty economics — silently dropping out of Price Guard with nothing to signal
-- it. Filling the blanks again is a treadmill: it only ever covers what already exists.
--
-- The inheritance is a BEFORE INSERT trigger rather than logic in the sync worker, so it holds
-- for every path that can create a SKU — the worker, a CSV import, or code not written yet.
alter table public.commerce_catalogs
  add column if not exists default_min_margin_percent numeric(7,4) check (default_min_margin_percent between 0 and 99.9999),
  add column if not exists default_commission_percent numeric(7,4) check (default_commission_percent between 0 and 100),
  add column if not exists default_returns_reserve_percent numeric(7,4) check (default_returns_reserve_percent between 0 and 100),
  add column if not exists default_fulfillment_tiyin bigint check (default_fulfillment_tiyin >= 0),
  add column if not exists default_lead_time_days integer check (default_lead_time_days between 0 and 365),
  add column if not exists default_safety_stock integer check (default_safety_stock >= 0);

-- Unit cost has no catalogue default on purpose: it is a fact about one product's supplier,
-- and a shared guess would quietly poison every margin in the catalogue.

create or replace function public.commerce_sku_inherit_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.commerce_catalogs;
begin
  select * into d from public.commerce_catalogs where id = new.catalog_id;
  if not found then return new; end if;

  -- Only fills what the caller left null: an explicit value always wins over the default.
  new.min_margin_percent := coalesce(new.min_margin_percent, d.default_min_margin_percent);
  new.commission_percent := coalesce(new.commission_percent, d.default_commission_percent);
  new.returns_reserve_percent := coalesce(new.returns_reserve_percent, d.default_returns_reserve_percent);
  new.fulfillment_tiyin := coalesce(new.fulfillment_tiyin, d.default_fulfillment_tiyin);
  new.lead_time_days := coalesce(new.lead_time_days, d.default_lead_time_days);
  new.safety_stock := coalesce(new.safety_stock, d.default_safety_stock);
  return new;
end
$$;

drop trigger if exists commerce_skus_inherit_defaults on public.commerce_skus;
create trigger commerce_skus_inherit_defaults
before insert on public.commerce_skus
for each row execute function public.commerce_sku_inherit_defaults();

-- Applying a catalogue-wide proposal now does two things: it records the value as the
-- catalogue's default so future products inherit it, and it fills the blanks that already
-- exist. Without the first half the seller would have to repeat the action after every sync.
create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
  v_touched integer := 0;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;
  if v_proposal.commission_percent is not null then v_applied := array_append(v_applied, 'commission_percent'); end if;
  if v_proposal.fulfillment_tiyin is not null then v_applied := array_append(v_applied, 'fulfillment_tiyin'); end if;
  if v_proposal.returns_reserve_percent is not null then v_applied := array_append(v_applied, 'returns_reserve_percent'); end if;

  if v_proposal.sku_id is not null then
    if not exists (
      select 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
      where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'SKU does not belong to this account';
    end if;

    select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
    from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
    where field <> all (v_applied);

    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
      lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
      safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
      commission_percent = coalesce(v_proposal.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, s.returns_reserve_percent),
      estimated_fields = v_estimated,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.id = v_proposal.sku_id;
    v_touched := 1;
  else
    if not exists (
      select 1 from public.commerce_catalogs c
      where c.id = v_proposal.catalog_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'catalogue does not belong to this account';
    end if;

    -- The value becomes the catalogue's standing default, so tomorrow's products inherit it.
    update public.commerce_catalogs c set
      default_min_margin_percent = coalesce(v_proposal.min_margin_percent, c.default_min_margin_percent),
      default_commission_percent = coalesce(v_proposal.commission_percent, c.default_commission_percent),
      default_returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, c.default_returns_reserve_percent),
      default_fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, c.default_fulfillment_tiyin),
      default_lead_time_days = coalesce(v_proposal.lead_time_days, c.default_lead_time_days),
      default_safety_stock = coalesce(v_proposal.safety_stock, c.default_safety_stock)
    where c.id = v_proposal.catalog_id;

    -- And the products that already exist get their blanks filled. Deliberate per-SKU values
    -- are never flattened by a catalogue-wide action.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      min_margin_percent = coalesce(s.min_margin_percent, v_proposal.min_margin_percent),
      lead_time_days = coalesce(s.lead_time_days, v_proposal.lead_time_days),
      safety_stock = coalesce(s.safety_stock, v_proposal.safety_stock),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
        or (v_proposal.min_margin_percent is not null and s.min_margin_percent is null)
        or (v_proposal.lead_time_days is not null and s.lead_time_days is null)
        or (v_proposal.safety_stock is not null and s.safety_stock is null)
      );
    get diagnostics v_touched = row_count;
  end if;

  update public.commerce_economics_proposals
  set status = 'applied', applied_at = now() where id = v_proposal.id;

  return jsonb_build_object(
    'sku_id', v_proposal.sku_id,
    'catalog_id', v_proposal.catalog_id,
    'applied_fields', to_jsonb(v_applied),
    'skus_touched', v_touched
  );
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;

-- ─── 20260806170000_commerce_manual_sync.sql ─────────────────────────────────────────────────
-- Manual "sync now" needs a memory, or a seller waiting for a shop to appear will hold the
-- button down and hammer Uzum on their own key — the account that gets rate-limited is theirs,
-- not ours. One timestamp per account is enough; the pilot row already exists per account.
alter table public.commerce_pilots
  add column if not exists last_manual_sync_at timestamptz;

-- Claims the manual sync slot atomically. Two tabs pressing the button at the same instant
-- must not both pass the check: the UPDATE's own WHERE clause is the lock.
create or replace function public.claim_commerce_manual_sync(p_account uuid, p_cooldown_seconds integer default 600)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pilot public.commerce_pilots;
  v_claimed boolean := false;
begin
  select * into v_pilot from public.commerce_pilots where account_id = p_account;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_pilot');
  end if;
  if v_pilot.status <> 'active' or v_pilot.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'pilot_inactive');
  end if;

  update public.commerce_pilots
  set last_manual_sync_at = now()
  where account_id = p_account
    and (last_manual_sync_at is null or last_manual_sync_at <= now() - make_interval(secs => p_cooldown_seconds));
  get diagnostics v_claimed = row_count;

  if not v_claimed then
    return jsonb_build_object(
      'ok', false,
      'reason', 'cooldown',
      'retry_after_seconds',
      ceil(extract(epoch from (v_pilot.last_manual_sync_at + make_interval(secs => p_cooldown_seconds) - now())))
    );
  end if;

  -- Give this account's failed runs another chance. Scoped to the caller's catalogues: a manual
  -- retry must never reset another tenant's runs.
  update public.commerce_sync_runs r
  set status = 'queued', claim_token = null, claimed_at = null, completed_at = null, error = null
  from public.commerce_catalogs c
  where c.id = r.catalog_id
    and c.account_id = p_account
    and r.status = 'failed'
    and r.scheduled_for > now() - interval '24 hours';

  return jsonb_build_object('ok', true, 'requeued', (
    select count(*) from public.commerce_sync_runs r2
    join public.commerce_catalogs c2 on c2.id = r2.catalog_id
    where c2.account_id = p_account and r2.status = 'queued'
  ));
end
$$;

revoke all on function public.claim_commerce_manual_sync(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_commerce_manual_sync(uuid, integer) to service_role;

-- ─── 20260806180000_commerce_uzum_facts.sql ──────────────────────────────────────────────────
-- Uzum already returns the commission, the category and the physical dimensions of every SKU.
-- The worker fetched them every four hours and threw them away, while the seller was asked to
-- supply the same numbers by hand. These columns keep the facts, and api_fields records which
-- values came from Uzum so a later sync may refresh them WITHOUT ever overwriting a number the
-- owner typed or confirmed themselves.
alter table public.commerce_skus
  add column if not exists uzum_category text,
  add column if not exists length_mm integer check (length_mm >= 0),
  add column if not exists width_mm integer check (width_mm >= 0),
  add column if not exists height_mm integer check (height_mm >= 0),
  add column if not exists weight_g integer check (weight_g >= 0),
  add column if not exists api_fields jsonb not null default '[]'::jsonb
    check (jsonb_typeof(api_fields) = 'array');

comment on column public.commerce_skus.api_fields is
  'Economics fields whose current value came from the Uzum API. A sync may refresh these; it must never touch a field the owner set.';

-- Ownership of a value is three-way and the three are mutually exclusive per field:
--   api_fields        - Uzum said so; refreshable by the worker
--   estimated_fields  - Nemo guessed; cannot raise a critical alert
--   neither           - the owner stated it; nothing may overwrite it
create or replace function public.commerce_apply_uzum_facts(
  p_sku_id uuid,
  p_category text,
  p_commission numeric,
  p_fulfillment_tiyin bigint,
  p_return_percent numeric,
  p_length integer,
  p_width integer,
  p_height integer,
  p_weight integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku public.commerce_skus;
  v_api jsonb;
  v_estimated jsonb;
  v_owns_commission boolean;
  v_owns_fulfillment boolean;
  v_owns_returns boolean;
begin
  select * into v_sku from public.commerce_skus where id = p_sku_id;
  if not found then return; end if;

  v_api := coalesce(v_sku.api_fields, '[]'::jsonb);
  v_estimated := coalesce(v_sku.estimated_fields, '[]'::jsonb);

  -- "The owner owns it" means: it has a value that came from neither Uzum nor a Nemo estimate.
  v_owns_commission := v_sku.commission_percent is not null
    and not (v_api ? 'commission_percent') and not (v_estimated ? 'commission_percent');
  v_owns_fulfillment := v_sku.fulfillment_tiyin is not null
    and not (v_api ? 'fulfillment_tiyin') and not (v_estimated ? 'fulfillment_tiyin');
  v_owns_returns := v_sku.returns_reserve_percent is not null
    and not (v_api ? 'returns_reserve_percent') and not (v_estimated ? 'returns_reserve_percent');

  update public.commerce_skus s set
    uzum_category = coalesce(p_category, s.uzum_category),
    length_mm = coalesce(p_length, s.length_mm),
    width_mm = coalesce(p_width, s.width_mm),
    height_mm = coalesce(p_height, s.height_mm),
    weight_g = coalesce(p_weight, s.weight_g),
    commission_percent = case when v_owns_commission or p_commission is null
      then s.commission_percent else p_commission end,
    fulfillment_tiyin = case when v_owns_fulfillment or p_fulfillment_tiyin is null
      then s.fulfillment_tiyin else p_fulfillment_tiyin end,
    -- The observed return rate is a fact, but it is history on possibly tiny volumes rather
    -- than a policy reserve — so it lands as an ESTIMATE and can never raise a critical alert.
    returns_reserve_percent = case when v_owns_returns or p_return_percent is null
      then s.returns_reserve_percent else least(p_return_percent, 100) end,
    api_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        v_api
        || case when p_commission is not null and not v_owns_commission then '["commission_percent"]'::jsonb else '[]'::jsonb end
        || case when p_fulfillment_tiyin is not null and not v_owns_fulfillment then '["fulfillment_tiyin"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    estimated_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        -- A value Uzum supplied is no longer a guess.
        (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(v_estimated) as e
         where not (p_commission is not null and not v_owns_commission and e = 'commission_percent')
           and not (p_fulfillment_tiyin is not null and not v_owns_fulfillment and e = 'fulfillment_tiyin'))
        || case when p_return_percent is not null and not v_owns_returns then '["returns_reserve_percent"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = p_sku_id;
end
$$;

revoke all on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer) to service_role;

-- ─── 20260806190000_commerce_uzum_facts_batch.sql ────────────────────────────────────────────
-- One round trip per catalogue instead of one per SKU. The per-SKU version made 140 sequential
-- calls for a single shop and blew the function's 150-second limit — correct logic, unusable
-- shape. The ownership rules are unchanged; only the batching is.
create or replace function public.commerce_apply_uzum_facts_batch(p_facts jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_applied integer := 0;
begin
  if jsonb_typeof(p_facts) <> 'array' then
    raise exception using errcode = '22023', message = 'facts must be a json array';
  end if;

  for v_fact in select value from jsonb_array_elements(p_facts) loop
    perform public.commerce_apply_uzum_facts(
      (v_fact->>'sku_id')::uuid,
      v_fact->>'category',
      (v_fact->>'commission')::numeric,
      (v_fact->>'fulfillment_tiyin')::bigint,
      (v_fact->>'return_percent')::numeric,
      (v_fact->>'length')::integer,
      (v_fact->>'width')::integer,
      (v_fact->>'height')::integer,
      (v_fact->>'weight')::integer
    );
    v_applied := v_applied + 1;
  end loop;
  return v_applied;
end
$$;

revoke all on function public.commerce_apply_uzum_facts_batch(jsonb) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts_batch(jsonb) to service_role;

-- ─── 20260806200000_commerce_facts_skip_unchanged.sql ────────────────────────────────────────
-- Every four hours Uzum sends back the same commission and the same dimensions, and the first
-- version rewrote all of them anyway: 140 updates, 140 revision bumps, on data that had not
-- moved. That pushed a single shop past the function's time limit.
--
-- A sync now touches only what actually changed. Steady state costs one comparison per SKU.
create or replace function public.commerce_apply_uzum_facts(
  p_sku_id uuid,
  p_category text,
  p_commission numeric,
  p_fulfillment_tiyin bigint,
  p_return_percent numeric,
  p_length integer,
  p_width integer,
  p_height integer,
  p_weight integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku public.commerce_skus;
  v_api jsonb;
  v_estimated jsonb;
  v_owns_commission boolean;
  v_owns_fulfillment boolean;
  v_owns_returns boolean;
  v_next_commission numeric;
  v_next_fulfillment bigint;
  v_next_returns numeric;
begin
  select * into v_sku from public.commerce_skus where id = p_sku_id;
  if not found then return; end if;

  v_api := coalesce(v_sku.api_fields, '[]'::jsonb);
  v_estimated := coalesce(v_sku.estimated_fields, '[]'::jsonb);

  -- "The owner owns it" means: a value that came from neither Uzum nor a Nemo estimate.
  v_owns_commission := v_sku.commission_percent is not null
    and not (v_api ? 'commission_percent') and not (v_estimated ? 'commission_percent');
  v_owns_fulfillment := v_sku.fulfillment_tiyin is not null
    and not (v_api ? 'fulfillment_tiyin') and not (v_estimated ? 'fulfillment_tiyin');
  v_owns_returns := v_sku.returns_reserve_percent is not null
    and not (v_api ? 'returns_reserve_percent') and not (v_estimated ? 'returns_reserve_percent');

  v_next_commission := case when v_owns_commission or p_commission is null
    then v_sku.commission_percent else p_commission end;
  v_next_fulfillment := case when v_owns_fulfillment or p_fulfillment_tiyin is null
    then v_sku.fulfillment_tiyin else p_fulfillment_tiyin end;
  v_next_returns := case when v_owns_returns or p_return_percent is null
    then v_sku.returns_reserve_percent else least(p_return_percent, 100) end;

  -- Nothing moved: no write, no revision bump, no recomputation downstream.
  if v_next_commission is not distinct from v_sku.commission_percent
     and v_next_fulfillment is not distinct from v_sku.fulfillment_tiyin
     and v_next_returns is not distinct from v_sku.returns_reserve_percent
     and coalesce(p_category, v_sku.uzum_category) is not distinct from v_sku.uzum_category
     and coalesce(p_length, v_sku.length_mm) is not distinct from v_sku.length_mm
     and coalesce(p_width, v_sku.width_mm) is not distinct from v_sku.width_mm
     and coalesce(p_height, v_sku.height_mm) is not distinct from v_sku.height_mm
     and coalesce(p_weight, v_sku.weight_g) is not distinct from v_sku.weight_g
  then
    return;
  end if;

  update public.commerce_skus s set
    uzum_category = coalesce(p_category, s.uzum_category),
    length_mm = coalesce(p_length, s.length_mm),
    width_mm = coalesce(p_width, s.width_mm),
    height_mm = coalesce(p_height, s.height_mm),
    weight_g = coalesce(p_weight, s.weight_g),
    commission_percent = v_next_commission,
    fulfillment_tiyin = v_next_fulfillment,
    -- The observed return rate is a fact, but it is history on possibly tiny volumes rather
    -- than a policy reserve — so it lands as an ESTIMATE and can never raise a critical alert.
    returns_reserve_percent = v_next_returns,
    api_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        v_api
        || case when p_commission is not null and not v_owns_commission then '["commission_percent"]'::jsonb else '[]'::jsonb end
        || case when p_fulfillment_tiyin is not null and not v_owns_fulfillment then '["fulfillment_tiyin"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    estimated_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        -- A value Uzum supplied is no longer a guess.
        (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(v_estimated) as e
         where not (p_commission is not null and not v_owns_commission and e = 'commission_percent')
           and not (p_fulfillment_tiyin is not null and not v_owns_fulfillment and e = 'fulfillment_tiyin'))
        || case when p_return_percent is not null and not v_owns_returns then '["returns_reserve_percent"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = p_sku_id;
end
$$;

revoke all on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer) to service_role;

-- ─── 20260806210000_commerce_returns_sample.sql ──────────────────────────────────────────────
-- The return reserve used to be Uzum's `returnedPercentage` copied straight through. On this
-- catalogue that produced 83% on a scarf (five returns against six lifetime sales) and turned 98
-- of 140 SKUs into "loss-making" ones. The rate is now shrunk toward the category and the
-- catalogue in _shared/returnsReserve.ts, and the sample it rests on is stored alongside it so
-- the interface can say how much the number is worth.
alter table public.commerce_skus
  add column if not exists returns_sample_units integer;

comment on column public.commerce_skus.returns_sample_units is
  'Lifetime units sold behind returns_reserve_percent. Small samples mean the reserve is mostly borrowed from the category.';

-- The signature gains p_return_sample_units, so the old one is dropped rather than overloaded:
-- two functions differing only in arity would let a stale caller keep writing unshrunk rates.
drop function if exists public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer);

create function public.commerce_apply_uzum_facts(
  p_sku_id uuid,
  p_category text,
  p_commission numeric,
  p_fulfillment_tiyin bigint,
  p_return_percent numeric,
  p_return_sample_units integer,
  p_length integer,
  p_width integer,
  p_height integer,
  p_weight integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku public.commerce_skus;
  v_api jsonb;
  v_estimated jsonb;
  v_owns_commission boolean;
  v_owns_fulfillment boolean;
  v_owns_returns boolean;
  v_next_commission numeric;
  v_next_fulfillment bigint;
  v_next_returns numeric;
  v_next_sample integer;
begin
  select * into v_sku from public.commerce_skus where id = p_sku_id;
  if not found then return; end if;

  v_api := coalesce(v_sku.api_fields, '[]'::jsonb);
  v_estimated := coalesce(v_sku.estimated_fields, '[]'::jsonb);

  -- "The owner owns it" means: a value that came from neither Uzum nor a Nemo estimate.
  v_owns_commission := v_sku.commission_percent is not null
    and not (v_api ? 'commission_percent') and not (v_estimated ? 'commission_percent');
  v_owns_fulfillment := v_sku.fulfillment_tiyin is not null
    and not (v_api ? 'fulfillment_tiyin') and not (v_estimated ? 'fulfillment_tiyin');
  v_owns_returns := v_sku.returns_reserve_percent is not null
    and not (v_api ? 'returns_reserve_percent') and not (v_estimated ? 'returns_reserve_percent');

  v_next_commission := case when v_owns_commission or p_commission is null
    then v_sku.commission_percent else p_commission end;
  v_next_fulfillment := case when v_owns_fulfillment or p_fulfillment_tiyin is null
    then v_sku.fulfillment_tiyin else p_fulfillment_tiyin end;
  v_next_returns := case when v_owns_returns or p_return_percent is null
    then v_sku.returns_reserve_percent else least(p_return_percent, 100) end;
  -- The sample describes Uzum's own history, so it follows the reserve rather than the owner:
  -- when the owner has set their own reserve, the sample behind it is theirs and stays untouched.
  v_next_sample := case when v_owns_returns then v_sku.returns_sample_units
    else coalesce(p_return_sample_units, v_sku.returns_sample_units) end;

  -- Nothing moved: no write, no revision bump, no recomputation downstream.
  if v_next_commission is not distinct from v_sku.commission_percent
     and v_next_fulfillment is not distinct from v_sku.fulfillment_tiyin
     and v_next_returns is not distinct from v_sku.returns_reserve_percent
     and v_next_sample is not distinct from v_sku.returns_sample_units
     and coalesce(p_category, v_sku.uzum_category) is not distinct from v_sku.uzum_category
     and coalesce(p_length, v_sku.length_mm) is not distinct from v_sku.length_mm
     and coalesce(p_width, v_sku.width_mm) is not distinct from v_sku.width_mm
     and coalesce(p_height, v_sku.height_mm) is not distinct from v_sku.height_mm
     and coalesce(p_weight, v_sku.weight_g) is not distinct from v_sku.weight_g
  then
    return;
  end if;

  update public.commerce_skus s set
    uzum_category = coalesce(p_category, s.uzum_category),
    length_mm = coalesce(p_length, s.length_mm),
    width_mm = coalesce(p_width, s.width_mm),
    height_mm = coalesce(p_height, s.height_mm),
    weight_g = coalesce(p_weight, s.weight_g),
    commission_percent = v_next_commission,
    fulfillment_tiyin = v_next_fulfillment,
    -- Still an ESTIMATE, and deliberately so. Shrinking the rate makes it usable; it does not
    -- make it a policy the owner agreed to, so it can never raise a critical alert.
    returns_reserve_percent = v_next_returns,
    returns_sample_units = v_next_sample,
    api_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        v_api
        || case when p_commission is not null and not v_owns_commission then '["commission_percent"]'::jsonb else '[]'::jsonb end
        || case when p_fulfillment_tiyin is not null and not v_owns_fulfillment then '["fulfillment_tiyin"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    estimated_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        -- A value Uzum supplied is no longer a guess.
        (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(v_estimated) as e
         where not (p_commission is not null and not v_owns_commission and e = 'commission_percent')
           and not (p_fulfillment_tiyin is not null and not v_owns_fulfillment and e = 'fulfillment_tiyin'))
        || case when p_return_percent is not null and not v_owns_returns then '["returns_reserve_percent"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = p_sku_id;
end
$$;

revoke all on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer, integer) to service_role;

create or replace function public.commerce_apply_uzum_facts_batch(p_facts jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_applied integer := 0;
begin
  if jsonb_typeof(p_facts) <> 'array' then
    raise exception using errcode = '22023', message = 'facts must be a json array';
  end if;

  for v_fact in select value from jsonb_array_elements(p_facts) loop
    perform public.commerce_apply_uzum_facts(
      (v_fact->>'sku_id')::uuid,
      v_fact->>'category',
      (v_fact->>'commission')::numeric,
      (v_fact->>'fulfillment_tiyin')::bigint,
      (v_fact->>'return_percent')::numeric,
      (v_fact->>'return_sample_units')::integer,
      (v_fact->>'length')::integer,
      (v_fact->>'width')::integer,
      (v_fact->>'height')::integer,
      (v_fact->>'weight')::integer
    );
    v_applied := v_applied + 1;
  end loop;
  return v_applied;
end
$$;

revoke all on function public.commerce_apply_uzum_facts_batch(jsonb) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts_batch(jsonb) to service_role;

-- Rates already stored came from the unshrunk percentage. They are wrong in a way no future sync
-- would repair on its own: the skip-unchanged branch compares against them, so a corrected rate
-- that happens to match would be treated as "nothing moved". Clearing them forces one honest
-- rewrite on the next sync, and until then the SKU reports missing data rather than a bad number.
update public.commerce_skus
   set returns_reserve_percent = null,
       economics_revision = economics_revision + 1,
       economics_updated_at = now()
 where estimated_fields @> '["returns_reserve_percent"]'
   and returns_reserve_percent is not null;

-- ─── 20260806220000_commerce_recommendations_resolved.sql ────────────────────────────────────
-- An alert had no way to stop being true. `dismissed` means the owner said no, `accepted` means
-- they acted, `expired` means it aged out — none of them fit "the margin recovered and Nemo no
-- longer raises this". So a price_guard row from a run before the margin model was corrected sat
-- open indefinitely, telling the owner to raise a price that no longer needed raising.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_status_check;

alter table public.commerce_recommendations
  add constraint commerce_recommendations_status_check
  check (status in ('open', 'dismissed', 'accepted', 'expired', 'resolved'));

alter table public.commerce_recommendations
  add column if not exists resolved_at timestamptz;

comment on column public.commerce_recommendations.resolved_at is
  'When a sync stopped raising this alert. Set by the worker, never by the owner — dismissed is the owner''s verb.';

-- Everything currently open was computed by the old margin model, which charged a returned unit
-- its full retail price. The next sync re-raises whatever is still true; leaving these open would
-- keep the corrected SKUs under an alert they have already cleared.
update public.commerce_recommendations
   set status = 'resolved', resolved_at = now()
 where status = 'open'
   and kind = 'price_guard';

-- ─── 20260806230000_browser_observation_total_length.sql ─────────────────────────────────────
-- A snapshot that lost half its page still read as a complete one. The bridge already returns
-- whether it truncated, but only to the extension, in the moment — nothing survived to the row an
-- agent reads hours later. The tariff capture that started this is stored at exactly 8000
-- characters with its last sentence cut in half, and nothing in the row says so.
alter table public.browser_observations
  add column if not exists total_length integer;

comment on column public.browser_observations.total_length is
  'Characters the page actually held. Greater than length(body_text) means this observation is partial.';

-- ─── 20260806240000_commerce_listing_drafts.sql ──────────────────────────────────────────────
-- Listing Agent: a product the owner describes, turned into a draft that already knows what it
-- costs to sell.
--
-- THERE IS NO PUBLISHED STATUS, AND THERE MUST NOT BE ONE. The Uzum integration is read-only;
-- Nemo cannot create a listing in the seller's cabinet and will not pretend it did. 'ready' means
-- the owner approved the text and can paste it in themselves. A status the platform cannot
-- honestly set is a status that eventually lies to whoever reads the row.
create table if not exists public.commerce_listing_drafts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- Which catalogue's economics the draft was priced against. Commission comes from categories
  -- this catalogue already sells in, so the numbers are only meaningful next to it.
  catalog_id uuid references public.commerce_catalogs(id) on delete set null,
  source_text text not null check (char_length(source_text) between 1 and 4000),

  title_ru text check (char_length(title_ru) <= 100),
  title_uz text check (char_length(title_uz) <= 100),
  description_ru text check (char_length(description_ru) <= 800),
  description_uz text check (char_length(description_uz) <= 800),
  -- [{name, value}] the owner actually stated, and the names of the ones they did not.
  attributes jsonb not null default '[]'::jsonb check (jsonb_typeof(attributes) = 'array'),
  unknown_attributes jsonb not null default '[]'::jsonb check (jsonb_typeof(unknown_attributes) = 'array'),

  uzum_category text check (char_length(uzum_category) <= 160),
  commission_percent numeric(7,4) check (commission_percent between 0 and 100),
  returns_reserve_percent numeric(7,4) check (returns_reserve_percent between 0 and 100),
  length_mm integer check (length_mm > 0),
  width_mm integer check (width_mm > 0),
  height_mm integer check (height_mm > 0),
  weight_g integer check (weight_g > 0),
  fulfillment_tiyin bigint check (fulfillment_tiyin >= 0),
  unit_cost_tiyin bigint check (unit_cost_tiyin >= 0),
  min_margin_percent numeric(7,4) check (min_margin_percent between 0 and 99.9999),
  min_selling_price_tiyin bigint check (min_selling_price_tiyin >= 0),
  -- What the owner still has to supply. Empty means the draft is fully grounded.
  missing jsonb not null default '[]'::jsonb check (jsonb_typeof(missing) = 'array'),
  -- The exact substrings every extracted number came from, so the owner can check the parse.
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),

  status text not null default 'draft' check (status in ('draft', 'ready', 'discarded')),
  created_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A draft may only be marked ready by someone, at some time, together.
  check ((status = 'ready') = (approved_at is not null))
);

create index if not exists commerce_listing_drafts_account_idx
  on public.commerce_listing_drafts(account_id, status, created_at desc);

alter table public.commerce_listing_drafts enable row level security;
revoke all on public.commerce_listing_drafts from public, anon, authenticated;
grant select on public.commerce_listing_drafts to authenticated;

-- Read-only to the tenant, like every other commerce table: writes go through commerce-control,
-- which checks the owner role. Cross-tenant reads return zero rows rather than an error.
create policy commerce_listing_drafts_account_read on public.commerce_listing_drafts for select to authenticated
  using (account_id = public.current_account_id());

-- ─── 20260806250000_commerce_uzum_purchase_price.sql ─────────────────────────────────────────
-- Uzum states the purchase price on every completed sale. Nemo was guessing it at half of retail:
-- on one boni that guess was 17 500 against a real 7 500, and that factor of 2.3 sat inside every
-- margin, floor price and alert the product produced.
--
-- The ownership rule is the one commission already follows, and it is the whole point: a fact from
-- Uzum replaces a Nemo ESTIMATE and never touches a number the owner stated themselves. An owner
-- who typed their cost has said something Uzum does not know — a different supplier, a different
-- batch — and a sync that overwrote it would silently discard the better number.
alter table public.commerce_skus
  add column if not exists unit_cost_source text
  check (unit_cost_source is null or unit_cost_source in ('uzum_sale', 'owner', 'estimate'));

comment on column public.commerce_skus.unit_cost_source is
  'Where unit_cost_tiyin came from. uzum_sale = purchasePrice on a completed sale; owner = stated by the seller; estimate = Nemo placeholder.';

drop function if exists public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, integer, integer, integer, integer);

create function public.commerce_apply_uzum_facts(
  p_sku_id uuid,
  p_category text,
  p_commission numeric,
  p_fulfillment_tiyin bigint,
  p_return_percent numeric,
  p_return_sample_units integer,
  p_unit_cost_tiyin bigint,
  p_length integer,
  p_width integer,
  p_height integer,
  p_weight integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sku public.commerce_skus;
  v_api jsonb;
  v_estimated jsonb;
  v_owns_commission boolean;
  v_owns_fulfillment boolean;
  v_owns_returns boolean;
  v_owns_cost boolean;
  v_next_commission numeric;
  v_next_fulfillment bigint;
  v_next_returns numeric;
  v_next_sample integer;
  v_next_cost bigint;
  v_next_cost_source text;
begin
  select * into v_sku from public.commerce_skus where id = p_sku_id;
  if not found then return; end if;

  v_api := coalesce(v_sku.api_fields, '[]'::jsonb);
  v_estimated := coalesce(v_sku.estimated_fields, '[]'::jsonb);

  -- "The owner owns it" means: a value that came from neither Uzum nor a Nemo estimate.
  v_owns_commission := v_sku.commission_percent is not null
    and not (v_api ? 'commission_percent') and not (v_estimated ? 'commission_percent');
  v_owns_fulfillment := v_sku.fulfillment_tiyin is not null
    and not (v_api ? 'fulfillment_tiyin') and not (v_estimated ? 'fulfillment_tiyin');
  v_owns_returns := v_sku.returns_reserve_percent is not null
    and not (v_api ? 'returns_reserve_percent') and not (v_estimated ? 'returns_reserve_percent');
  v_owns_cost := v_sku.unit_cost_tiyin is not null
    and not (v_api ? 'unit_cost_tiyin') and not (v_estimated ? 'unit_cost_tiyin');

  v_next_commission := case when v_owns_commission or p_commission is null
    then v_sku.commission_percent else p_commission end;
  v_next_fulfillment := case when v_owns_fulfillment or p_fulfillment_tiyin is null
    then v_sku.fulfillment_tiyin else p_fulfillment_tiyin end;
  v_next_returns := case when v_owns_returns or p_return_percent is null
    then v_sku.returns_reserve_percent else least(p_return_percent, 100) end;
  v_next_sample := case when v_owns_returns then v_sku.returns_sample_units
    else coalesce(p_return_sample_units, v_sku.returns_sample_units) end;
  v_next_cost := case when v_owns_cost or p_unit_cost_tiyin is null
    then v_sku.unit_cost_tiyin else p_unit_cost_tiyin end;
  v_next_cost_source := case
    when v_owns_cost then 'owner'
    when p_unit_cost_tiyin is not null then 'uzum_sale'
    when v_sku.unit_cost_tiyin is not null and (v_estimated ? 'unit_cost_tiyin') then 'estimate'
    else v_sku.unit_cost_source
  end;

  -- Nothing moved: no write, no revision bump, no recomputation downstream.
  if v_next_commission is not distinct from v_sku.commission_percent
     and v_next_fulfillment is not distinct from v_sku.fulfillment_tiyin
     and v_next_returns is not distinct from v_sku.returns_reserve_percent
     and v_next_sample is not distinct from v_sku.returns_sample_units
     and v_next_cost is not distinct from v_sku.unit_cost_tiyin
     and v_next_cost_source is not distinct from v_sku.unit_cost_source
     and coalesce(p_category, v_sku.uzum_category) is not distinct from v_sku.uzum_category
     and coalesce(p_length, v_sku.length_mm) is not distinct from v_sku.length_mm
     and coalesce(p_width, v_sku.width_mm) is not distinct from v_sku.width_mm
     and coalesce(p_height, v_sku.height_mm) is not distinct from v_sku.height_mm
     and coalesce(p_weight, v_sku.weight_g) is not distinct from v_sku.weight_g
  then
    return;
  end if;

  update public.commerce_skus s set
    uzum_category = coalesce(p_category, s.uzum_category),
    length_mm = coalesce(p_length, s.length_mm),
    width_mm = coalesce(p_width, s.width_mm),
    height_mm = coalesce(p_height, s.height_mm),
    weight_g = coalesce(p_weight, s.weight_g),
    commission_percent = v_next_commission,
    fulfillment_tiyin = v_next_fulfillment,
    -- Still an ESTIMATE, and deliberately so. Shrinking the rate makes it usable; it does not
    -- make it a policy the owner agreed to, so it can never raise a critical alert.
    returns_reserve_percent = v_next_returns,
    returns_sample_units = v_next_sample,
    unit_cost_tiyin = v_next_cost,
    unit_cost_source = v_next_cost_source,
    api_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        v_api
        || case when p_commission is not null and not v_owns_commission then '["commission_percent"]'::jsonb else '[]'::jsonb end
        || case when p_fulfillment_tiyin is not null and not v_owns_fulfillment then '["fulfillment_tiyin"]'::jsonb else '[]'::jsonb end
        -- A cost Uzum charged on a real sale is a fact, and it stops being an estimate the moment
        -- it lands. That is what lets Price Guard raise a critical alert on this SKU at all.
        || case when p_unit_cost_tiyin is not null and not v_owns_cost then '["unit_cost_tiyin"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    estimated_fields = (
      select coalesce(jsonb_agg(distinct field), '[]'::jsonb) from jsonb_array_elements_text(
        -- A value Uzum supplied is no longer a guess.
        (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements_text(v_estimated) as e
         where not (p_commission is not null and not v_owns_commission and e = 'commission_percent')
           and not (p_fulfillment_tiyin is not null and not v_owns_fulfillment and e = 'fulfillment_tiyin')
           and not (p_unit_cost_tiyin is not null and not v_owns_cost and e = 'unit_cost_tiyin'))
        || case when p_return_percent is not null and not v_owns_returns then '["returns_reserve_percent"]'::jsonb else '[]'::jsonb end
      ) as field
    ),
    economics_revision = s.economics_revision + 1,
    economics_updated_at = now()
  where s.id = p_sku_id;
end
$$;

revoke all on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, bigint, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts(uuid, text, numeric, bigint, numeric, integer, bigint, integer, integer, integer, integer) to service_role;

create or replace function public.commerce_apply_uzum_facts_batch(p_facts jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fact jsonb;
  v_applied integer := 0;
begin
  if jsonb_typeof(p_facts) <> 'array' then
    raise exception using errcode = '22023', message = 'facts must be a json array';
  end if;

  for v_fact in select value from jsonb_array_elements(p_facts) loop
    perform public.commerce_apply_uzum_facts(
      (v_fact->>'sku_id')::uuid,
      v_fact->>'category',
      (v_fact->>'commission')::numeric,
      (v_fact->>'fulfillment_tiyin')::bigint,
      (v_fact->>'return_percent')::numeric,
      (v_fact->>'return_sample_units')::integer,
      (v_fact->>'unit_cost_tiyin')::bigint,
      (v_fact->>'length')::integer,
      (v_fact->>'width')::integer,
      (v_fact->>'height')::integer,
      (v_fact->>'weight')::integer
    );
    v_applied := v_applied + 1;
  end loop;
  return v_applied;
end
$$;

revoke all on function public.commerce_apply_uzum_facts_batch(jsonb) from public, anon, authenticated;
grant execute on function public.commerce_apply_uzum_facts_batch(jsonb) to service_role;

-- Backfill the label for costs already on file, so "where did this number come from" has an answer
-- for every row and not only the ones a future sync happens to touch.
update public.commerce_skus
   set unit_cost_source = case when estimated_fields ? 'unit_cost_tiyin' then 'estimate' else 'owner' end
 where unit_cost_tiyin is not null and unit_cost_source is null;

-- ─── 20260806260000_commerce_cost_batch.sql ──────────────────────────────────────────────────
-- A dictated batch is several proposals that must be confirmed as one thing. The owner said
-- "бони 18000, шарф 22000, заколки 9000" in one breath and pressed one button; applying two of
-- the three because the third raced would leave them believing all three landed.
alter table public.commerce_economics_proposals
  add column if not exists batch_key uuid;

comment on column public.commerce_economics_proposals.batch_key is
  'Groups proposals dictated in one message so a single confirmation applies all of them.';

create index if not exists commerce_economics_proposals_batch_idx
  on public.commerce_economics_proposals(batch_key, status) where batch_key is not null;

-- Applies every pending proposal in a batch, and reports what actually moved.
--
-- Ownership is unchanged: this calls the same per-proposal function the single-item flow uses, so
-- a confirmed cost lands exactly the way a dictated one does — as the owner's own number, which
-- outranks anything a later sync reads from Uzum.
create or replace function public.apply_commerce_cost_batch(p_batch_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal record;
  v_applied integer := 0;
  v_skipped integer := 0;
  v_result jsonb;
begin
  if p_batch_key is null then
    raise exception using errcode = '22023', message = 'batch key is required';
  end if;

  -- Ordered and locked so two presses of the same button cannot both apply it. The second press
  -- finds nothing pending and reports zero, which is the truth.
  for v_proposal in
    select id from public.commerce_economics_proposals
     where batch_key = p_batch_key and status = 'pending' and expires_at > now()
     order by created_at
     for update skip locked
  loop
    v_result := public.apply_commerce_economics_proposal(v_proposal.id);
    if coalesce(jsonb_array_length(v_result->'applied_fields'), 0) > 0 then
      v_applied := v_applied + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  -- Anything left pending in this batch expired between the card and the press. Marked, so it
  -- cannot be applied later by a stale button.
  update public.commerce_economics_proposals
     set status = 'expired'
   where batch_key = p_batch_key and status = 'pending';

  return jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
end
$$;

revoke all on function public.apply_commerce_cost_batch(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_cost_batch(uuid) to service_role;

-- ─── 20260806270000_commerce_owner_value_outranks_uzum.sql ───────────────────────────────────
-- Two things the confirmation path got wrong, both about provenance.
--
-- 1. A confirmed value was removed from estimated_fields but LEFT IN api_fields. The Uzum sync
--    reads ownership as "present in neither list", so for any SKU whose cost Uzum had supplied,
--    the next sync would overwrite the number the owner had just dictated. The owner knows
--    something Uzum does not — a different supplier, a different batch — and their word has to
--    outrank a reading, not lose to it four hours later.
--
-- 2. unit_cost_source was never set here, so a cost the owner dictated kept the label 'estimate'.
--    The column exists to answer "where did this number come from"; a label that says the wrong
--    thing is worse than no label, because it is believed.
create or replace function public.apply_commerce_economics_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.commerce_economics_proposals;
  v_applied text[] := '{}';
  v_estimated jsonb;
  v_api jsonb;
  v_touched integer := 0;
begin
  select * into v_proposal from public.commerce_economics_proposals
  where id = p_proposal_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'proposal not found';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception using errcode = '23514', message = 'proposal is not pending';
  end if;
  if v_proposal.expires_at <= now() then
    update public.commerce_economics_proposals set status = 'expired' where id = v_proposal.id;
    raise exception using errcode = '23514', message = 'proposal expired';
  end if;

  if v_proposal.unit_cost_tiyin is not null then v_applied := array_append(v_applied, 'unit_cost_tiyin'); end if;
  if v_proposal.lead_time_days is not null then v_applied := array_append(v_applied, 'lead_time_days'); end if;
  if v_proposal.safety_stock is not null then v_applied := array_append(v_applied, 'safety_stock'); end if;
  if v_proposal.min_margin_percent is not null then v_applied := array_append(v_applied, 'min_margin_percent'); end if;
  if v_proposal.commission_percent is not null then v_applied := array_append(v_applied, 'commission_percent'); end if;
  if v_proposal.fulfillment_tiyin is not null then v_applied := array_append(v_applied, 'fulfillment_tiyin'); end if;
  if v_proposal.returns_reserve_percent is not null then v_applied := array_append(v_applied, 'returns_reserve_percent'); end if;

  if v_proposal.sku_id is not null then
    if not exists (
      select 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
      where s.id = v_proposal.sku_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'SKU does not belong to this account';
    end if;

    select coalesce(jsonb_agg(field), '[]'::jsonb) into v_estimated
    from jsonb_array_elements_text((select estimated_fields from public.commerce_skus where id = v_proposal.sku_id)) as field
    where field <> all (v_applied);

    -- Out of BOTH lists. A field in neither is owned by the owner, and that is the only state a
    -- later sync will not touch.
    select coalesce(jsonb_agg(field), '[]'::jsonb) into v_api
    from jsonb_array_elements_text((select coalesce(api_fields, '[]'::jsonb) from public.commerce_skus where id = v_proposal.sku_id)) as field
    where field <> all (v_applied);

    update public.commerce_skus s set
      unit_cost_tiyin = coalesce(v_proposal.unit_cost_tiyin, s.unit_cost_tiyin),
      unit_cost_source = case when v_proposal.unit_cost_tiyin is not null then 'owner' else s.unit_cost_source end,
      lead_time_days = coalesce(v_proposal.lead_time_days, s.lead_time_days),
      safety_stock = coalesce(v_proposal.safety_stock, s.safety_stock),
      min_margin_percent = coalesce(v_proposal.min_margin_percent, s.min_margin_percent),
      commission_percent = coalesce(v_proposal.commission_percent, s.commission_percent),
      fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, s.fulfillment_tiyin),
      returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, s.returns_reserve_percent),
      estimated_fields = v_estimated,
      api_fields = v_api,
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.id = v_proposal.sku_id;
    v_touched := 1;
  else
    if not exists (
      select 1 from public.commerce_catalogs c
      where c.id = v_proposal.catalog_id and c.account_id = v_proposal.account_id
    ) then
      raise exception using errcode = '42501', message = 'catalogue does not belong to this account';
    end if;

    -- The value becomes the catalogue's standing default, so tomorrow's products inherit it.
    update public.commerce_catalogs c set
      default_min_margin_percent = coalesce(v_proposal.min_margin_percent, c.default_min_margin_percent),
      default_commission_percent = coalesce(v_proposal.commission_percent, c.default_commission_percent),
      default_returns_reserve_percent = coalesce(v_proposal.returns_reserve_percent, c.default_returns_reserve_percent),
      default_fulfillment_tiyin = coalesce(v_proposal.fulfillment_tiyin, c.default_fulfillment_tiyin),
      default_lead_time_days = coalesce(v_proposal.lead_time_days, c.default_lead_time_days),
      default_safety_stock = coalesce(v_proposal.safety_stock, c.default_safety_stock)
    where c.id = v_proposal.catalog_id;

    -- And the products that already exist get their blanks filled. Deliberate per-SKU values
    -- are never flattened by a catalogue-wide action.
    update public.commerce_skus s set
      commission_percent = coalesce(s.commission_percent, v_proposal.commission_percent),
      fulfillment_tiyin = coalesce(s.fulfillment_tiyin, v_proposal.fulfillment_tiyin),
      returns_reserve_percent = coalesce(s.returns_reserve_percent, v_proposal.returns_reserve_percent),
      min_margin_percent = coalesce(s.min_margin_percent, v_proposal.min_margin_percent),
      lead_time_days = coalesce(s.lead_time_days, v_proposal.lead_time_days),
      safety_stock = coalesce(s.safety_stock, v_proposal.safety_stock),
      economics_revision = s.economics_revision + 1,
      economics_updated_at = now()
    where s.catalog_id = v_proposal.catalog_id
      and (
        (v_proposal.commission_percent is not null and s.commission_percent is null)
        or (v_proposal.fulfillment_tiyin is not null and s.fulfillment_tiyin is null)
        or (v_proposal.returns_reserve_percent is not null and s.returns_reserve_percent is null)
        or (v_proposal.min_margin_percent is not null and s.min_margin_percent is null)
        or (v_proposal.lead_time_days is not null and s.lead_time_days is null)
        or (v_proposal.safety_stock is not null and s.safety_stock is null)
      );
    get diagnostics v_touched = row_count;
  end if;

  update public.commerce_economics_proposals
     set status = 'applied', applied_at = now()
   where id = v_proposal.id;

  return jsonb_build_object('applied_fields', to_jsonb(v_applied), 'skus_touched', v_touched);
end
$$;

revoke all on function public.apply_commerce_economics_proposal(uuid) from public, anon, authenticated;
grant execute on function public.apply_commerce_economics_proposal(uuid) to service_role;

-- Repair the rows already confirmed under the old function: a cost in neither list is the owner's,
-- and it was labelled an estimate.
update public.commerce_skus
   set unit_cost_source = 'owner'
 where unit_cost_tiyin is not null
   and not (coalesce(estimated_fields, '[]'::jsonb) ? 'unit_cost_tiyin')
   and not (coalesce(api_fields, '[]'::jsonb) ? 'unit_cost_tiyin')
   and unit_cost_source is distinct from 'owner';

-- ─── 20260806280000_commerce_stockout.sql ────────────────────────────────────────────────────
-- The reorder planner answers "when will this run out". It needs a week of history to know the
-- velocity, and until then it says nothing at all — while 94 of this seller's 140 SKUs are already
-- at zero. Two thirds of the catalogue is not sellable today, and no amount of history is needed
-- to see it: the stock came from Uzum this morning.
--
-- So a third kind of finding, which costs nothing to compute and is true from the first sync.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_kind_check;

alter table public.commerce_recommendations
  add constraint commerce_recommendations_kind_check
  check (kind in ('reorder', 'price_guard', 'missing_data', 'stockout'));

comment on constraint commerce_recommendations_kind_check on public.commerce_recommendations is
  'stockout: the SKU is at zero stock now. Independent of sales history, unlike reorder.';

-- ─── 20260807190000_commerce_freshness_watchdog.sql ──────────────────────────────────────────
-- A watchdog that lives inside the thing it watches is not a watchdog.
--
-- Every commerce finding is produced by the sync. If the Uzum key expires or the API changes shape,
-- no new finding appears — and the digest, which sends only findings it has not sent today, finds
-- nothing to send and stays quiet. The seller does not get an empty report that looks wrong; they
-- get no report at all, which looks exactly like a calm week. A silent failure that presents as
-- good news is the worst shape a failure can take, and it is the one shape this system had.
--
-- So freshness is read at delivery time, from the delivery path, which runs whether or not the
-- sync does.
alter table public.commerce_catalogs
  add column if not exists stale_alerted_at timestamptz;

comment on column public.commerce_catalogs.stale_alerted_at is
  'When the owner was told this catalogue stopped updating. Cleared the moment data returns, so a '
  'second outage alerts again while one continuous outage alerts once.';

-- max(observed_at) rather than last_synced_at. The two disagree in exactly the case that matters:
-- a sync that reaches Uzum, is answered with an empty list, and completes having written nothing
-- stamps last_synced_at and looks healthy forever. Snapshots are the data; a sync run is only an
-- attempt to fetch it.
create index if not exists commerce_inventory_snapshots_sku_observed_idx
  on public.commerce_inventory_snapshots(sku_id, observed_at desc);

-- One round trip for every pilot catalogue. Deliberately not security definer: under the service
-- role this sees everything the digest needs, and under a signed-in owner the underlying RLS
-- scopes it to their own catalogues without this function having to re-implement that check.
create or replace function public.commerce_catalog_freshness(p_account_ids uuid[])
returns table (
  catalog_id uuid,
  owner_account_id uuid,
  catalog_name text,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_observed_at timestamptz,
  last_sync_error text,
  stale_alerted_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.account_id,
    c.name,
    c.created_at,
    c.last_synced_at,
    (select max(s.observed_at)
       from public.commerce_inventory_snapshots s
       join public.commerce_skus k on k.id = s.sku_id
      where k.catalog_id = c.id),
    c.last_sync_error,
    c.stale_alerted_at
  from public.commerce_catalogs c
  where c.account_id = any(p_account_ids)
    and c.status = 'active'
  order by c.created_at, c.id
$$;

comment on function public.commerce_catalog_freshness(uuid[]) is
  'Per-catalogue freshness for the silence watchdog: when data last actually arrived, not when a '
  'sync last claimed to run.';

-- ─── 20260807200000_org_memory.sql ───────────────────────────────────────────────────────────
-- Общая память организации: то, что компания выяснила, работая.
--
-- Документы, которые загрузил человек, уже раздаются команде через match_knowledge_team. Они
-- истинны по определению — их принёс владелец. Здесь другое: утверждения, которые вывели агенты.
-- Вывод регулярно ошибается, поэтому у него обязаны быть происхождение, счёт свидетельств, срок
-- годности и исход. Без них ошибка становится неотличима от факта уже на следующем прогоне.
--
-- Конструкция и разбор ревью: ORG_MEMORY_DESIGN_RU.md (ревизия 2).

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Во что организация верит
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.org_claims (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id()
                  references public.accounts(id) on delete cascade,

  -- Читаемое отдельно от контекста, в котором родилось. «Клиент платит после демо» — да.
  -- «Он согласился» — нет: через месяц непонятно, кто и на что.
  statement     text not null check (char_length(statement) between 8 and 600),
  kind          text not null check (kind in ('fact', 'preference', 'constraint', 'lesson')),

  -- Свободный ключ вида 'client:uuid', 'channel:telegram'. Ядро не знает, что такое клиент —
  -- только что это ключ. Доменная нейтральность держится на этом.
  subject       text not null check (char_length(subject) between 1 and 120),
  subject_key   text not null check (char_length(subject_key) between 1 and 120),

  -- Старшинство. Слово владельца перебивает вывод агента — тот же принцип, что в Commerce,
  -- где значение владельца старше значения Uzum.
  source        text not null check (source in ('owner', 'agent', 'tool', 'outcome')),
  source_detail jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(source_detail) = 'object'),
  run_ref       uuid,

  -- Минимальная привилегия ВНУТРИ аккаунта. Изоляция арендаторов — не то же самое: факт,
  -- выведенный при работе с одним клиентом, не обязан быть виден агенту, занятому другим.
  audience      text not null default 'account'
                  check (audience in ('account', 'department', 'agent', 'owner_only')),
  audience_ref  uuid,

  -- УВЕРЕННОСТЬ КАК СЧЁТ СВИДЕТЕЛЬСТВ. Колонки для присвоения нет вовсе — это и есть защита
  -- от самоубеждения: агент физически не может поднять себе уверенность, ему нечего записать.
  -- Beta(1,1) на старте даёт 0.5, что здесь означает незнание, а не «пятьдесят на пятьдесят».
  evidence_for     integer not null default 0 check (evidence_for >= 0),
  evidence_against integer not null default 0 check (evidence_against >= 0),
  confidence    numeric(4,3) generated always as (
                  round((1 + evidence_for)::numeric / (2 + evidence_for + evidence_against), 3)
                ) stored,

  valid_from    timestamptz not null default now(),
  valid_until   timestamptz,

  status        text not null default 'active'
                  check (status in ('active', 'retired', 'disputed')),
  supersedes    uuid,

  embedding       public.vector(384),
  embedding_model text not null default 'gte-small',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Опора для составных внешних ключей: межаккаунтная ссылка становится невозможной физически,
  -- а не по договорённости.
  unique (account_id, id),
  constraint org_claims_supersedes_same_account
    foreign key (account_id, supersedes) references public.org_claims (account_id, id)
    on delete set null,
  -- Сужение круга чтения без указания, до кого именно, — это не сужение.
  constraint org_claims_audience_ref_present check (
    (audience in ('account', 'owner_only') and audience_ref is null)
    or (audience in ('department', 'agent') and audience_ref is not null)
  )
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Что организация сделала
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.org_decisions (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null default public.current_account_id()
                 references public.accounts(id) on delete cascade,

  -- Ссылка на существующий леджер, не новый источник истины. Аудит, не авторизация.
  source       text not null check (source in ('approval', 'recommendation', 'run', 'manual')),
  source_id    uuid,
  summary      text not null check (char_length(summary) between 4 and 400),

  -- Измеримое ожидание. Проверяется схемой, а не договорённостью: предсказание без метрики,
  -- оператора и значения — пожелание, а из пожеланий не учатся.
  expected     jsonb not null,
  horizon_at   timestamptz not null,

  -- Версия политики на момент решения. evolve-agent меняет промпты автоматически (autoMode),
  -- и исход, измеренный через две недели, может относиться к другому агенту.
  policy_ref   jsonb not null default '{}'::jsonb check (jsonb_typeof(policy_ref) = 'object'),

  outcome      text not null default 'pending'
                 check (outcome in ('pending', 'confirmed', 'refuted', 'unmeasurable')),
  observed     jsonb,
  resolved_at  timestamptz,

  created_at   timestamptz not null default now(),

  unique (account_id, id),
  constraint org_decisions_horizon_after_creation check (horizon_at > created_at),
  constraint org_decisions_expected_measurable check (
    jsonb_typeof(expected) = 'object'
    and jsonb_typeof(expected -> 'metric') = 'string'
    and (expected ->> 'op') in ('>=', '>', '<=', '<', '==', '!=')
    and expected ? 'value'
  ),
  constraint org_decisions_resolved_consistent check (
    (outcome = 'pending' and resolved_at is null)
    or (outcome <> 'pending' and resolved_at is not null)
  )
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- На каких убеждениях решение стояло
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Массив uuid[] был бы дешевле и неверен: ни поэлементного внешнего ключа, ни привязки к
-- арендатору, ни метаданных присвоения заслуги. Чужой claim_id вставился бы молча.
create table if not exists public.org_decision_claims (
  account_id   uuid not null,
  decision_id  uuid not null,
  claim_id     uuid not null,

  -- Присвоение заслуги. Пять убеждений и один сработавший текст: плюс всем пятерым — это не
  -- калибровка, а порча памяти. Автоматически двигается только primary, и только одиночный.
  role         text not null default 'context'
                 check (role in ('primary', 'supporting', 'context')),
  weight       numeric(4,3) not null default 1.000 check (weight between 0 and 1),

  -- Чем было убеждение НА МОМЕНТ решения. Иначе исход применится к переписанному смыслу.
  confidence_at_decision numeric(4,3) not null check (confidence_at_decision between 0 and 1),
  statement_hash         text not null check (char_length(statement_hash) between 8 and 128),

  created_at   timestamptz not null default now(),

  primary key (account_id, decision_id, claim_id),
  foreign key (account_id, decision_id) references public.org_decisions (account_id, id) on delete cascade,
  foreign key (account_id, claim_id)    references public.org_claims    (account_id, id) on delete cascade
);

-- Ровно одна главная гипотеза на решение. Без этого автоматическое обучение выключено —
-- и это правильное поведение по умолчанию, а не ограничение.
create unique index if not exists org_decision_claims_one_primary_idx
  on public.org_decision_claims (account_id, decision_id) where role = 'primary';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Идемпотентность извлечения
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- persist_worker_research_run завершает прогон атомарно, и после неё прогон терминален.
-- Извлекать кандидатов до транзакции — двойная запись при повторе; после — потеря при падении;
-- внутри — лишний вызов модели в критической секции под лизом. Значит, выходной ящик.
create table if not exists public.org_memory_outbox (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  run_ref      uuid not null,
  event_type   text not null check (event_type in ('extract_claims', 'resolve_outcome')),
  payload      jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status       text not null default 'pending'
                 check (status in ('pending', 'processing', 'done', 'failed')),
  attempts     integer not null default 0 check (attempts >= 0),
  claimed_at   timestamptz,
  processed_at timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  -- Вся идемпотентность держится на этой строке.
  unique (account_id, run_ref, event_type)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Индексы
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Намеренно БЕЗ индекса HNSW по embedding. Он плохо дружит с предфильтром по аккаунту и теряет
-- полноту, а «отбор первым» в SQL не гарантирует порядок исполнения. На сотнях утверждений
-- точная сортировка по уже суженному множеству дешевле. Замер до выбора стратегии, а не после.
create index if not exists org_claims_recall_idx
  on public.org_claims (account_id, kind, subject_key) where status = 'active';
create index if not exists org_claims_run_idx
  on public.org_claims (account_id, run_ref) where run_ref is not null;
create index if not exists org_decisions_due_idx
  on public.org_decisions (account_id, horizon_at) where outcome = 'pending';
create index if not exists org_outbox_due_idx
  on public.org_memory_outbox (status, created_at) where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Изоляция
-- ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.org_claims          enable row level security;
alter table public.org_decisions       enable row level security;
alter table public.org_decision_claims enable row level security;
alter table public.org_memory_outbox   enable row level security;

-- Владелец ВИДИТ, во что система верит. Неисправляемая память хуже отсутствующей, а исправить
-- можно только то, что видно.
drop policy if exists org_claims_read on public.org_claims;
create policy org_claims_read on public.org_claims for select
  using (account_id = public.current_account_id());

drop policy if exists org_decisions_read on public.org_decisions;
create policy org_decisions_read on public.org_decisions for select
  using (account_id = public.current_account_id());

drop policy if exists org_decision_claims_read on public.org_decision_claims;
create policy org_decision_claims_read on public.org_decision_claims for select
  using (account_id = public.current_account_id());

-- Но НЕ пишет напрямую: source='owner' нельзя подделать задним числом, а счётчики свидетельств
-- нельзя выкрутить. Образец — approval_requests.
revoke insert, update, delete on public.org_claims          from anon, authenticated;
revoke insert, update, delete on public.org_decisions       from anon, authenticated;
revoke insert, update, delete on public.org_decision_claims from anon, authenticated;
revoke all                    on public.org_memory_outbox   from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.org_claims_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists org_claims_touch_trg on public.org_claims;
create trigger org_claims_touch_trg before update on public.org_claims
  for each row execute function public.org_claims_touch();

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Поиск
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Принимает kind и subject_key, в отличие от первой редакции конструкции: без них маршрутизация
-- по фазам нереализуема, а фильтрация top-k после выборки молча теряет релевантное.
--
-- p_account_id здесь — УТВЕРЖДЕНИЕ, а не граница доступа: security definer и service role
-- обходят RLS. Границу ставит вызывающий; для воркера — org_claims_recall_for_run ниже.
create or replace function public.match_org_claims(
  p_account_id    uuid,
  p_query         public.vector(384),
  p_kinds         text[] default null,
  p_subject_key   text default null,
  p_agent_id      uuid default null,
  p_department_id uuid default null,
  p_k             int default 8
)
returns table (
  id uuid, statement text, kind text, subject text, source text,
  confidence numeric, evidence_for int, evidence_against int, similarity double precision
)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.statement, c.kind, c.subject, c.source,
         c.confidence, c.evidence_for, c.evidence_against,
         -- Оператор назван схемой явно: при search_path = '' он иначе не резолвится, а ронять
         -- пустой путь ради оператора значит менять границу безопасности ради синтаксиса.
         1 - (c.embedding operator(public.<=>) p_query)
    from public.org_claims c
   where c.account_id = p_account_id
     and c.status = 'active'
     and c.embedding is not null
     and (c.valid_until is null or c.valid_until > now())
     and (p_kinds is null or c.kind = any(p_kinds))
     and (p_subject_key is null or c.subject_key = p_subject_key)
     -- owner_only не попадает агентам ни при каких параметрах.
     and (
       c.audience = 'account'
       or (c.audience = 'agent' and c.audience_ref = p_agent_id)
       or (c.audience = 'department' and c.audience_ref = p_department_id)
     )
   order by c.embedding operator(public.<=>) p_query
   limit greatest(1, least(p_k, 20))
$$;

-- Безопасный вход для воркера: аккаунт ВЫВОДИТСЯ из захваченного чекпоинта, а не принимается
-- рядом с ним. Личность прогона и аккаунт как два независимых параметра — это приглашение
-- к подмене одного из них.
create or replace function public.org_claims_recall_for_run(
  p_checkpoint_id uuid,
  p_claim_token   uuid,
  p_query         public.vector(384),
  p_kinds         text[] default null,
  p_subject_key   text default null,
  p_k             int default 8
)
returns table (
  id uuid, statement text, kind text, subject text, source text,
  confidence numeric, evidence_for int, evidence_against int, similarity double precision
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_account uuid;
begin
  select r.account_id into v_account
    from public.autonomous_run_checkpoints r
   where r.id = p_checkpoint_id and r.claim_token = p_claim_token and r.status = 'running';
  if v_account is null then
    raise exception using errcode = '42501', message = 'worker claim lost';
  end if;
  return query select * from public.match_org_claims(v_account, p_query, p_kinds, p_subject_key, null, null, p_k);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Запись
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Целостность живёт здесь; семантика (дедуп по эмбеддингу, отсев императивов) — в orgMemory.ts,
-- где её можно протестировать вне Deno.
--
-- Возвращает, что произошло: 'inserted' | 'reinforced' | 'refused_owner_conflict' | 'disputed'.
create or replace function public.org_claim_record(
  p_account_id    uuid,
  p_statement     text,
  p_kind          text,
  p_subject       text,
  p_subject_key   text,
  p_source        text,
  p_source_detail jsonb default '{}'::jsonb,
  p_run_ref       uuid default null,
  p_audience      text default 'account',
  p_audience_ref  uuid default null,
  p_embedding     public.vector(384) default null,
  p_conflicts     uuid[] default '{}'
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_owner_conflict int;
  v_agent_conflict int;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Конфликтующие утверждения ищет вызывающий (это семантика), но проверяет их принадлежность
  -- аккаунту база: подсунутый чужой id не должен ни на что повлиять.
  select count(*) into v_owner_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id
     and c.status = 'active' and c.source = 'owner';

  -- Владелец старше. Агент не переписывает то, что сказал человек.
  if v_owner_conflict > 0 and p_source <> 'owner' then
    return jsonb_build_object('result', 'refused_owner_conflict', 'conflicts', v_owner_conflict);
  end if;

  insert into public.org_claims (
    account_id, statement, kind, subject, subject_key, source, source_detail,
    run_ref, audience, audience_ref, embedding
  ) values (
    p_account_id, p_statement, p_kind, p_subject, p_subject_key, p_source,
    coalesce(p_source_detail, '{}'::jsonb), p_run_ref,
    coalesce(p_audience, 'account'), p_audience_ref, p_embedding
  )
  returning id into v_id;

  -- Два несовместимых вывода агентов не разрешаются молча в пользу нового. Система сообщает,
  -- что верит в два противоречащих утверждения, и отдаёт выбор владельцу.
  select count(*) into v_agent_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id and c.status = 'active';

  if v_agent_conflict > 0 then
    update public.org_claims set status = 'disputed'
     where account_id = p_account_id and (id = any(p_conflicts) or id = v_id);
    return jsonb_build_object('result', 'disputed', 'id', v_id, 'with', v_agent_conflict);
  end if;

  return jsonb_build_object('result', 'inserted', 'id', v_id);
end;
$$;

-- Владелец снимает неверное утверждение. Авторизация по членству в аккаунте: сегодня в каждом
-- аккаунте ровно один пользователь, поэтому «член» и есть владелец. Когда появятся команды,
-- сюда понадобится роль — отдельным решением, а не молчаливым расширением этой проверки.
create or replace function public.org_claim_retire(p_claim_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid := public.current_account_id();
  v_updated int;
begin
  if v_account is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;
  update public.org_claims
     set status = 'retired',
         source_detail = source_detail || jsonb_build_object('retired_reason', coalesce(p_reason, ''), 'retired_by', 'owner')
   where id = p_claim_id and account_id = v_account and status <> 'retired';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('retired', v_updated);
end;
$$;

-- Отзыв целого прогона. Прогон оказался мусорным — все порождённые им убеждения снимаются
-- одним запросом. Без этого плохой прогон отравляет память навсегда.
create or replace function public.org_claims_retract_run(p_account_id uuid, p_run_ref uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_updated int;
begin
  update public.org_claims set status = 'retired'
   where account_id = p_account_id and run_ref = p_run_ref and status <> 'retired';
  get diagnostics v_updated = row_count;
  return jsonb_build_object('retired', v_updated);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Исход
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Идемпотентно по построению: переход pending → решённое и начисление свидетельства происходят
-- в одном операторе. Повтор cron не начислит дважды, потому что второй раз строка уже не pending.
--
-- Свидетельство получает ТОЛЬКО одиночная главная гипотеза. Решение, где primary не назначен или
-- их несколько, остаётся зарегистрированным, но необучающим — и это честнее, чем раздать плюс
-- всем связанным убеждениям и назвать это калибровкой.
create or replace function public.org_decision_resolve(
  p_decision_id uuid,
  p_outcome     text,
  p_observed    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_account uuid;
  v_primary uuid;
  v_primaries int;
begin
  if p_outcome not in ('confirmed', 'refuted', 'unmeasurable') then
    raise exception using errcode = '22023', message = 'outcome must be confirmed, refuted or unmeasurable';
  end if;

  update public.org_decisions
     set outcome = p_outcome, observed = coalesce(p_observed, '{}'::jsonb), resolved_at = now()
   where id = p_decision_id and outcome = 'pending'
  returning account_id into v_account;

  if v_account is null then
    return jsonb_build_object('applied', false, 'reason', 'already_resolved_or_missing');
  end if;

  select count(*), min(claim_id) into v_primaries, v_primary
    from public.org_decision_claims
   where account_id = v_account and decision_id = p_decision_id and role = 'primary';

  if p_outcome = 'unmeasurable' or v_primaries <> 1 then
    return jsonb_build_object('applied', true, 'learned', false,
      'reason', case when p_outcome = 'unmeasurable' then 'unmeasurable' else 'no_single_primary' end);
  end if;

  update public.org_claims
     set evidence_for     = evidence_for     + case when p_outcome = 'confirmed' then 1 else 0 end,
         evidence_against = evidence_against + case when p_outcome = 'refuted'   then 1 else 0 end
   where id = v_primary and account_id = v_account;

  -- Снятие — не по среднему, а по накопленным свидетельствам: пять неудач подряд против одного
  -- слабого коррелированного наблюдения не должны весить одинаково.
  update public.org_claims
     set status = 'retired'
   where id = v_primary and account_id = v_account and status = 'active'
     and evidence_against >= 5 and confidence < 0.300;

  return jsonb_build_object('applied', true, 'learned', true, 'claim_id', v_primary);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Права
-- ─────────────────────────────────────────────────────────────────────────────────────────────
revoke all on function public.match_org_claims(uuid, public.vector, text[], text, uuid, uuid, int) from public, anon, authenticated;
grant execute on function public.match_org_claims(uuid, public.vector, text[], text, uuid, uuid, int) to service_role;

revoke all on function public.org_claims_recall_for_run(uuid, uuid, public.vector, text[], text, int) from public, anon, authenticated;
grant execute on function public.org_claims_recall_for_run(uuid, uuid, public.vector, text[], text, int) to service_role;

revoke all on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[]) from public, anon, authenticated;
grant execute on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[]) to service_role;

revoke all on function public.org_claims_retract_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.org_claims_retract_run(uuid, uuid) to service_role;

revoke all on function public.org_decision_resolve(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_resolve(uuid, text, jsonb) to service_role;

-- Единственная функция, доступная владельцу напрямую: он должен уметь опровергнуть то,
-- во что система верит, не проходя через агента.
revoke all on function public.org_claim_retire(uuid, text) from public, anon;
grant execute on function public.org_claim_retire(uuid, text) to authenticated, service_role;

comment on table public.org_claims is
  'Что организация вывела, работая. В отличие от knowledge_* — опровержимо, поэтому несёт '
  'происхождение, счёт свидетельств и срок годности.';
comment on column public.org_claims.confidence is
  'Вычисляемая из свидетельств. Присвоить нельзя — колонки для этого нет, и это защита от '
  'самоубеждения, а не удобство.';
comment on table public.org_decision_claims is
  'Нить обучения: без неё известно, что ошиблись, но не какое убеждение подвело.';

-- ─── 20260807210000_org_memory_wiring.sql ────────────────────────────────────────────────────
-- Подключение памяти: транзакционный выходной ящик.
--
-- persist_worker_research_run завершает прогон одной транзакцией и после неё прогон терминален.
-- Извлекать кандидатов в память до неё — двойная запись при повторе; после — потеря при падении,
-- потому что возвращаться уже некуда; внутри — лишний вызов модели в критической секции под лизом,
-- где он задерживает выдачу отчёта ради необязательного обучения.
--
-- Поэтому здесь появляется только строка задания, в той же транзакции, что и результат. Забрать
-- её и позвать модель — работа отдельного повторяемого воркера.
create or replace function public.persist_worker_research_run(
  p_worker_run_id uuid, p_claim_token uuid, p_account_id uuid, p_task text,
  p_status text, p_department_id uuid, p_run_ref uuid, p_report text,
  p_sources jsonb, p_steps jsonb, p_model text, p_tokens bigint, p_cost numeric
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare persisted_id uuid;
begin
  perform 1 from public.autonomous_run_checkpoints
  where id = p_worker_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token
  for update;
  if not found then raise exception 'worker claim lost'; end if;
  insert into public.research_runs(account_id, task, status, kind, department_id, run_ref, report, sources, steps, model, tokens, cost)
  values(p_account_id, p_task, p_status, 'team_run', p_department_id, p_run_ref, p_report, p_sources, p_steps, p_model, p_tokens, p_cost)
  returning id into persisted_id;
  update public.autonomous_run_checkpoints
  set state = state || jsonb_build_object(
        'result', p_report,
        'resultId', persisted_id,
        'escalatedCount', (select count(*) from jsonb_array_elements(p_steps) step where coalesce((step->'review'->>'needs_human_review')::boolean, false))
      ),
      phase = 'synth', transition = 'synth', status = 'completed',
      specialist_cursor = jsonb_array_length(p_steps), review_cursor = jsonb_array_length(p_steps),
      claim_token = null, claimed_at = null, last_error = null,
      next_attempt_at = now(), updated_at = now()
  where id = p_worker_run_id and claim_token = p_claim_token and status = 'running';
  if not found then raise exception 'worker claim lost'; end if;

  -- Вся идемпотентность держится на уникальности (account_id, run_ref, event_type): повторное
  -- завершение того же прогона не создаёт второго задания, и do nothing здесь — не небрежность,
  -- а само правило. Провал этой вставки не должен отменять уже посчитанный отчёт: обучение
  -- необязательно, отчёт обязателен.
  begin
    insert into public.org_memory_outbox (account_id, run_ref, event_type, payload)
    values (p_account_id, p_run_ref, 'extract_claims',
            jsonb_build_object('research_run_id', persisted_id, 'checkpoint_id', p_worker_run_id))
    on conflict (account_id, run_ref, event_type) do nothing;
  exception when others then
    null;
  end;

  return persisted_id;
end
$$;

revoke all on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) from public, anon, authenticated;
grant execute on function public.persist_worker_research_run(uuid,uuid,uuid,text,text,uuid,uuid,text,jsonb,jsonb,text,bigint,numeric) to service_role;

-- Забрать задание с лизом. skip locked, потому что два воркера не должны драться за одну строку,
-- а тот, кто опоздал, обязан взять следующую, а не ждать.
create or replace function public.org_memory_outbox_claim(p_limit int default 3, p_lease_seconds int default 300)
returns setof public.org_memory_outbox
language sql
security definer
set search_path = ''
as $$
  update public.org_memory_outbox o
     set status = 'processing', claimed_at = now(), attempts = o.attempts + 1
   where o.id in (
     select c.id from public.org_memory_outbox c
      where c.status = 'pending'
         -- Брошенное задание возвращается в работу: воркер мог умереть, не отчитавшись.
         or (c.status = 'processing' and c.claimed_at < now() - make_interval(secs => p_lease_seconds))
      order by c.created_at
      limit greatest(1, least(p_limit, 20))
      for update skip locked
   )
  returning o.*;
$$;

create or replace function public.org_memory_outbox_finish(p_id uuid, p_status text, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.org_memory_outbox
     set status = case when p_status in ('done', 'failed') then p_status else 'failed' end,
         processed_at = now(),
         last_error = left(p_error, 500)
   where id = p_id;
$$;

revoke all on function public.org_memory_outbox_claim(int, int) from public, anon, authenticated;
grant execute on function public.org_memory_outbox_claim(int, int) to service_role;
revoke all on function public.org_memory_outbox_finish(uuid, text, text) from public, anon, authenticated;
grant execute on function public.org_memory_outbox_finish(uuid, text, text) to service_role;

comment on function public.org_memory_outbox_claim(int, int) is
  'Лизует задания извлечения памяти. Обучение отделено от прогона, чтобы падение обучения не '
  'стоило отчёта, а падение прогона не стоило обучения.';

-- ─── 20260807220000_org_memory_health.sql ────────────────────────────────────────────────────
-- Отличить «памяти пока нет» от «память сломалась и молчит».
--
-- Отзыв утверждений деградирует мягко: не смог — вернул пустой список, прогон пошёл дальше. Это
-- верное поведение (прогон без памяти делает то, что делал вчера; упавший не делает ничего) и
-- оно же беззвучное. Пустой ответ выглядит одинаково в двух совершенно разных случаях: память
-- работает и пуста, или Supabase.ai недоступен и она не заработает никогда.
--
-- Ровно такой отказ мы вчера ловили в Commerce: тишина, читающаяся как спокойствие.
--
-- Ключевое наблюдение, на котором стоит вся конструкция: 'empty' — это УСПЕХ машинерии. Если
-- embedText отработал и запрос вернул ноль строк, путь жив. Сломано — это когда провалы есть,
-- а успехов нет ни одного.
create table if not exists public.org_memory_health (
  account_id  uuid not null references public.accounts(id) on delete cascade,
  day         date not null default (now() at time zone 'UTC')::date,

  -- Отзыв вернул утверждения.
  recalls_ok        integer not null default 0 check (recalls_ok >= 0),
  -- Отзыв отработал и не нашёл ничего. Не отказ: доказательство, что путь цел.
  recalls_empty     integer not null default 0 check (recalls_empty >= 0),
  -- Supabase.ai не отдал вектор. Тот самый случай, ради которого таблица и заведена.
  embed_failed      integer not null default 0 check (embed_failed >= 0),
  -- Вектор получен, но запрос к базе не прошёл.
  query_failed      integer not null default 0 check (query_failed >= 0),

  last_error     text,
  last_failed_at timestamptz,
  updated_at     timestamptz not null default now(),

  primary key (account_id, day)
);

alter table public.org_memory_health enable row level security;

drop policy if exists org_memory_health_read on public.org_memory_health;
create policy org_memory_health_read on public.org_memory_health for select
  using (account_id = public.current_account_id());

revoke insert, update, delete on public.org_memory_health from anon, authenticated;

create index if not exists org_memory_health_recent_idx
  on public.org_memory_health (day desc, account_id);

-- Один upsert на попытку отзыва. Дёшево: строка на аккаунт в сутки, и в режиме воркера отзыв
-- вообще один на прогон — остальные фазы работают от снимка.
create or replace function public.org_memory_health_record(
  p_account_id uuid,
  p_outcome    text,
  p_error      text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_account_id is null or p_outcome not in ('ok', 'empty', 'embed_failed', 'query_failed') then
    return;
  end if;
  insert into public.org_memory_health as h (
    account_id, day, recalls_ok, recalls_empty, embed_failed, query_failed, last_error, last_failed_at
  ) values (
    p_account_id, (now() at time zone 'UTC')::date,
    case when p_outcome = 'ok' then 1 else 0 end,
    case when p_outcome = 'empty' then 1 else 0 end,
    case when p_outcome = 'embed_failed' then 1 else 0 end,
    case when p_outcome = 'query_failed' then 1 else 0 end,
    case when p_outcome like '%failed' then left(p_error, 300) end,
    case when p_outcome like '%failed' then now() end
  )
  on conflict (account_id, day) do update set
    recalls_ok     = h.recalls_ok     + excluded.recalls_ok,
    recalls_empty  = h.recalls_empty  + excluded.recalls_empty,
    embed_failed   = h.embed_failed   + excluded.embed_failed,
    query_failed   = h.query_failed   + excluded.query_failed,
    -- Последняя ошибка не затирается успехом: она нужна, чтобы объяснить утренний провал вечером.
    last_error     = coalesce(excluded.last_error, h.last_error),
    last_failed_at = coalesce(excluded.last_failed_at, h.last_failed_at),
    updated_at     = now();
end;
$$;

-- Сводка за окно, для сторожа. Считает по всем аккаунтам: недоступность Supabase.ai — отказ
-- платформы, а не одного арендатора, и увидеть его надо по первому же аккаунту, а не по всем.
create or replace function public.org_memory_health_window(p_days int default 2)
returns table (
  attempts bigint, successes bigint, empties bigint,
  embed_failures bigint, query_failures bigint,
  accounts_affected bigint, last_error text, last_failed_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
  select
    coalesce(sum(h.recalls_ok + h.recalls_empty + h.embed_failed + h.query_failed), 0),
    coalesce(sum(h.recalls_ok), 0),
    coalesce(sum(h.recalls_empty), 0),
    coalesce(sum(h.embed_failed), 0),
    coalesce(sum(h.query_failed), 0),
    count(*) filter (where h.embed_failed + h.query_failed > 0),
    (array_agg(h.last_error order by h.last_failed_at desc nulls last))[1],
    max(h.last_failed_at)
  from public.org_memory_health h
  where h.day >= ((now() at time zone 'UTC')::date - greatest(1, least(p_days, 30)));
$$;

revoke all on function public.org_memory_health_record(uuid, text, text) from public, anon, authenticated;
grant execute on function public.org_memory_health_record(uuid, text, text) to service_role;
revoke all on function public.org_memory_health_window(int) from public, anon, authenticated;
grant execute on function public.org_memory_health_window(int) to service_role;

comment on column public.org_memory_health.recalls_empty is
  'Отзыв отработал и ничего не нашёл. Это успех машинерии, а не отказ: именно он отличает пустую '
  'память от сломанной.';

-- ─── 20260807230000_org_claim_ttl.sql ────────────────────────────────────────────────────────
-- Срок годности утверждения.
--
-- Первый живой прогон извлёк из отчёта «за последние 7 дней ни один товар не был продан» и
-- положил это в память навсегда. Утверждение было истинно неделю — и то по ошибке: в тот день
-- продажи читались нулём из-за бага, который мы починили позже. Вечное убеждение, выведенное из
-- моментального снимка, читается следующим прогоном как установленный факт и становится
-- основанием плана. Схема умела valid_until с самого начала; заполнять его было некому.
--
-- Опорное правило живёт в orgMemory.ts, где его можно протестировать: наблюдения стареют,
-- правила — нет. Здесь только возможность записать срок.

-- Снимаем старую сигнатуру целиком, а не добавляем параметр со значением по умолчанию: две
-- перегрузки с одинаковым префиксом аргументов — это вызов, который однажды уйдёт не туда.
drop function if exists public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[]);

create or replace function public.org_claim_record(
  p_account_id    uuid,
  p_statement     text,
  p_kind          text,
  p_subject       text,
  p_subject_key   text,
  p_source        text,
  p_source_detail jsonb default '{}'::jsonb,
  p_run_ref       uuid default null,
  p_audience      text default 'account',
  p_audience_ref  uuid default null,
  p_embedding     public.vector(384) default null,
  p_conflicts     uuid[] default '{}',
  p_valid_until   timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_owner_conflict int;
  v_agent_conflict int;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Конфликтующие утверждения ищет вызывающий (это семантика), но проверяет их принадлежность
  -- аккаунту база: подсунутый чужой id не должен ни на что повлиять.
  select count(*) into v_owner_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id
     and c.status = 'active' and c.source = 'owner';

  -- Владелец старше. Агент не переписывает то, что сказал человек.
  if v_owner_conflict > 0 and p_source <> 'owner' then
    return jsonb_build_object('result', 'refused_owner_conflict', 'conflicts', v_owner_conflict);
  end if;

  insert into public.org_claims (
    account_id, statement, kind, subject, subject_key, source, source_detail,
    run_ref, audience, audience_ref, embedding, valid_until
  ) values (
    p_account_id, p_statement, p_kind, p_subject, p_subject_key, p_source,
    coalesce(p_source_detail, '{}'::jsonb), p_run_ref,
    coalesce(p_audience, 'account'), p_audience_ref, p_embedding, p_valid_until
  )
  returning id into v_id;

  -- Два несовместимых вывода агентов не разрешаются молча в пользу нового. Система сообщает,
  -- что верит в два противоречащих утверждения, и отдаёт выбор владельцу.
  select count(*) into v_agent_conflict
    from public.org_claims c
   where c.id = any(p_conflicts) and c.account_id = p_account_id and c.status = 'active';

  if v_agent_conflict > 0 then
    update public.org_claims set status = 'disputed'
     where account_id = p_account_id and (id = any(p_conflicts) or id = v_id);
    return jsonb_build_object('result', 'disputed', 'id', v_id, 'with', v_agent_conflict);
  end if;

  return jsonb_build_object('result', 'inserted', 'id', v_id, 'valid_until', p_valid_until);
end;
$$;

revoke all on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[], timestamptz) from public, anon, authenticated;
grant execute on function public.org_claim_record(uuid, text, text, text, text, text, jsonb, uuid, text, uuid, public.vector, uuid[], timestamptz) to service_role;

-- Отзыв уже фильтрует по valid_until, так что истечение действует само собой и ничего чистить не
-- нужно. Индекс — чтобы фильтр не превращался в перебор, когда просроченных станет много.
create index if not exists org_claims_live_idx
  on public.org_claims (account_id, kind, subject_key, valid_until)
  where status = 'active';

comment on column public.org_claims.valid_until is
  'Когда наблюдение перестаёт быть свидетельством. Пусто только у правил: наблюдения стареют, '
  'правила — нет.';

-- ─── 20260807240000_org_outcome_resolver.sql ─────────────────────────────────────────────────
-- Обратная связь по исходу: регистрация решения и его разрешение по сроку.
--
-- Без этого «самообучение» остаётся переформулированием промпта. Убеждение получает свидетельство
-- только здесь, и только через измерение — ни агент, ни менеджер не могут его присвоить.
--
-- Резолвер живёт в SQL и вызывается cron'ом напрямую, без edge-функции. Не из экономии: у него
-- нет ни HTTP, ни секрета, ни холодного старта, а значит и трёх способов отказать молча.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Наблюдатель
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Ядро доменно-нейтрально: оно знает не «остаток товара», а «метрику по ключу». Список метрик —
-- единственное место, где вертикаль просачивается внутрь, и просачивается явно.
--
-- ВАЖНО: измеряем только по наблюдениям ПОСЛЕ горизонта. Данные, собранные до решения, ничего о
-- его исходе не говорят, а измерить ими и назвать это результатом — самый дешёвый способ получить
-- красивую точность ни о чём.
create or replace function public.org_observe_metric(
  p_account_id uuid,
  p_metric     text,
  p_params     jsonb,
  p_after      timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sku     uuid := nullif(p_params->>'sku_id', '')::uuid;
  v_catalog uuid := nullif(p_params->>'catalog_id', '')::uuid;
  v_value   numeric;
  v_at      timestamptz;
begin
  -- Принадлежность арендатору проверяется здесь, а не доверяется вызывающему: функция
  -- security definer, RLS её не прикрывает.
  if v_sku is not null then
    perform 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
     where s.id = v_sku and c.account_id = p_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account');
    end if;
  end if;
  if v_catalog is not null then
    perform 1 from public.commerce_catalogs c where c.id = v_catalog and c.account_id = p_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account');
    end if;
  end if;

  if p_metric = 'commerce.sku.stock_total' then
    select i.stock_total, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric = 'commerce.sku.sold_units_7d' then
    select i.sold_units_7d, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric in ('commerce.catalog.sold_units_7d', 'commerce.catalog.skus_at_zero') then
    -- По самому свежему полному слоту каталога после горизонта: смешивать соседние слоты значит
    -- складывать разные моменты времени и выдавать сумму за состояние.
    with slot as (
      select max(i.observed_slot) s
        from public.commerce_inventory_snapshots i
        join public.commerce_skus k on k.id = i.sku_id
       where k.catalog_id = v_catalog and i.observed_at > p_after
    )
    select case when p_metric = 'commerce.catalog.sold_units_7d'
                then sum(coalesce(i.sold_units_7d, 0))
                else count(*) filter (where coalesce(i.stock_total, 0) = 0) end,
           max(i.observed_at)
      into v_value, v_at
      from public.commerce_inventory_snapshots i
      join public.commerce_skus k on k.id = i.sku_id, slot
     where k.catalog_id = v_catalog and i.observed_slot = slot.s;

  else
    -- Незнакомая метрика — не ошибка вызова, а честное «измерить нечем».
    return jsonb_build_object('ok', false, 'reason', 'unknown_metric', 'metric', p_metric);
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'reason', 'no_observation_after_horizon');
  end if;
  return jsonb_build_object('ok', true, 'value', v_value, 'observed_at', v_at, 'metric', p_metric);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Регистрация решения
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Явная, а не автоматическая при согласовании. approval_requests фиксирует разрешение, а не
-- выполнение; учиться на разрешениях значит учиться на намерениях, включая те, что не состоялись.
--
-- Отказывает ГРОМКО на незнакомой метрике: лучше не зарегистрировать решение, чем зарегистрировать
-- и через неделю получить 'unmeasurable', приняв собственную небрежность за свойство мира.
create or replace function public.org_decision_register(
  p_account_id uuid,
  p_source     text,
  p_source_id  uuid,
  p_summary    text,
  p_expected   jsonb,
  p_horizon_at timestamptz,
  p_claims     jsonb default '[]'::jsonb,
  p_policy_ref jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_metric   text := p_expected->>'metric';
  v_probe    jsonb;
  v_link     jsonb;
  v_primaries int := 0;
  v_claim    record;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Проба наблюдателя на заведомо пустом окне: значение не нужно, нужен ответ, знает ли он метрику.
  v_probe := public.org_observe_metric(p_account_id, v_metric, coalesce(p_expected->'params', '{}'::jsonb), now() + interval '100 years');
  if v_probe->>'reason' = 'unknown_metric' then
    raise exception using errcode = '22023', message = 'unknown metric: ' || coalesce(v_metric, '(null)');
  end if;

  insert into public.org_decisions (account_id, source, source_id, summary, expected, horizon_at, policy_ref)
  values (p_account_id, p_source, p_source_id, p_summary, p_expected, p_horizon_at, coalesce(p_policy_ref, '{}'::jsonb))
  returning id into v_id;

  for v_link in select * from jsonb_array_elements(coalesce(p_claims, '[]'::jsonb))
  loop
    select c.id, c.confidence, c.statement into v_claim
      from public.org_claims c
     where c.id = (v_link->>'claim_id')::uuid and c.account_id = p_account_id;
    if not found then
      raise exception using errcode = '22023', message = 'claim not in account: ' || coalesce(v_link->>'claim_id', '(null)');
    end if;
    if coalesce(v_link->>'role', 'context') = 'primary' then
      v_primaries := v_primaries + 1;
    end if;
    insert into public.org_decision_claims (
      account_id, decision_id, claim_id, role, weight, confidence_at_decision, statement_hash
    ) values (
      p_account_id, v_id, v_claim.id,
      coalesce(v_link->>'role', 'context'),
      coalesce((v_link->>'weight')::numeric, 1.000),
      v_claim.confidence,
      md5(v_claim.statement)
    );
  end loop;

  return jsonb_build_object('id', v_id, 'claims', jsonb_array_length(coalesce(p_claims, '[]'::jsonb)),
                            'learnable', v_primaries = 1);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Резолвер
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Идемпотентность обеспечивает org_decision_resolve: переход pending → решённое и начисление
-- свидетельства происходят одним оператором, поэтому повтор cron не начислит дважды.
create or replace function public.org_decisions_resolve_due(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due       record;
  v_obs       jsonb;
  v_op        text;
  v_target    numeric;
  v_actual    numeric;
  v_holds     boolean;
  v_confirmed int := 0;
  v_refuted   int := 0;
  v_unmeasurable int := 0;
begin
  for v_due in
    select d.id, d.account_id, d.expected, d.horizon_at
      from public.org_decisions d
     where d.outcome = 'pending' and d.horizon_at <= now()
     order by d.horizon_at
     limit greatest(1, least(p_limit, 500))
     for update skip locked
  loop
    v_obs := public.org_observe_metric(
      v_due.account_id, v_due.expected->>'metric',
      coalesce(v_due.expected->'params', '{}'::jsonb), v_due.horizon_at);

    if coalesce((v_obs->>'ok')::boolean, false) is not true then
      -- Неизмеримое — полноправный исход и попадает в отчёт. Система, тихо отбрасывающая то,
      -- что не смогла измерить, показывает растущую точность, целиком созданную отбором.
      perform public.org_decision_resolve(v_due.id, 'unmeasurable', v_obs);
      v_unmeasurable := v_unmeasurable + 1;
      continue;
    end if;

    v_op     := v_due.expected->>'op';
    v_target := (v_due.expected->>'value')::numeric;
    v_actual := (v_obs->>'value')::numeric;
    v_holds  := case v_op
                  when '>='  then v_actual >= v_target
                  when '>'   then v_actual >  v_target
                  when '<='  then v_actual <= v_target
                  when '<'   then v_actual <  v_target
                  when '=='  then v_actual =  v_target
                  when '!='  then v_actual <> v_target
                end;

    if v_holds is null then
      perform public.org_decision_resolve(v_due.id, 'unmeasurable',
        v_obs || jsonb_build_object('reason', 'unknown_operator', 'op', v_op));
      v_unmeasurable := v_unmeasurable + 1;
    elsif v_holds then
      perform public.org_decision_resolve(v_due.id, 'confirmed', v_obs);
      v_confirmed := v_confirmed + 1;
    else
      perform public.org_decision_resolve(v_due.id, 'refuted', v_obs);
      v_refuted := v_refuted + 1;
    end if;
  end loop;

  return jsonb_build_object('confirmed', v_confirmed, 'refuted', v_refuted, 'unmeasurable', v_unmeasurable);
end;
$$;

-- Доля неизмеримого стоит рядом с точностью. Отдельно её никто не посмотрит, а вместе она
-- показывает, чего измерения на самом деле стоят.
create or replace function public.org_learning_scoreboard(p_days int default 90)
returns table (resolved bigint, confirmed bigint, refuted bigint, unmeasurable bigint,
               accuracy numeric, unmeasurable_share numeric)
language sql stable security definer set search_path = ''
as $$
  select count(*) filter (where outcome <> 'pending'),
         count(*) filter (where outcome = 'confirmed'),
         count(*) filter (where outcome = 'refuted'),
         count(*) filter (where outcome = 'unmeasurable'),
         round(count(*) filter (where outcome = 'confirmed')::numeric
               / nullif(count(*) filter (where outcome in ('confirmed', 'refuted')), 0), 3),
         round(count(*) filter (where outcome = 'unmeasurable')::numeric
               / nullif(count(*) filter (where outcome <> 'pending'), 0), 3)
    from public.org_decisions
   where resolved_at >= now() - make_interval(days => greatest(1, least(p_days, 365)));
$$;

revoke all on function public.org_observe_metric(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.org_observe_metric(uuid, text, jsonb, timestamptz) to service_role;
revoke all on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.org_decisions_resolve_due(int) from public, anon, authenticated;
grant execute on function public.org_decisions_resolve_due(int) to service_role;
revoke all on function public.org_learning_scoreboard(int) from public, anon;
grant execute on function public.org_learning_scoreboard(int) to authenticated, service_role;

comment on function public.org_observe_metric(uuid, text, jsonb, timestamptz) is
  'Измеряет метрику ПОСЛЕ горизонта решения. Данные до решения ничего о его исходе не говорят.';
comment on function public.org_learning_scoreboard(int) is
  'Точность рядом с долей неизмеримого: без второго первое врёт тем сильнее, чем хуже дела.';

-- ─── 20260807250000_org_decision_resolve_fix.sql ─────────────────────────────────────────────
-- min(uuid) в Postgres не существует.
--
-- Строка `select count(*), min(claim_id)` лежала в org_decision_resolve с первой миграции и ни
-- разу не выполнялась: решений не было, начислять свидетельство было нечему. Первый же настоящий
-- прогон резолвера уронил её с 42883.
--
-- Схемные проверки этого поймать не могли — они доказывали, что нельзя записать неизмеримое
-- ожидание и что исход не начисляется дважды, но ни одна не доходила до самого начисления.
-- Путь, который никто не исполнял, сломан по умолчанию.
create or replace function public.org_decision_resolve(
  p_decision_id uuid,
  p_outcome     text,
  p_observed    jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_primary uuid;
  v_primaries int;
begin
  if p_outcome not in ('confirmed', 'refuted', 'unmeasurable') then
    raise exception using errcode = '22023', message = 'outcome must be confirmed, refuted or unmeasurable';
  end if;

  update public.org_decisions
     set outcome = p_outcome, observed = coalesce(p_observed, '{}'::jsonb), resolved_at = now()
   where id = p_decision_id and outcome = 'pending'
  returning account_id into v_account;

  if v_account is null then
    return jsonb_build_object('applied', false, 'reason', 'already_resolved_or_missing');
  end if;

  -- array_agg вместо min: у uuid нет порядкового агрегата, а порядок здесь и не нужен —
  -- строка ровно одна, иначе решение необучающее.
  select count(*), (array_agg(claim_id))[1] into v_primaries, v_primary
    from public.org_decision_claims
   where account_id = v_account and decision_id = p_decision_id and role = 'primary';

  if p_outcome = 'unmeasurable' or v_primaries <> 1 then
    return jsonb_build_object('applied', true, 'learned', false,
      'reason', case when p_outcome = 'unmeasurable' then 'unmeasurable' else 'no_single_primary' end);
  end if;

  update public.org_claims
     set evidence_for     = evidence_for     + case when p_outcome = 'confirmed' then 1 else 0 end,
         evidence_against = evidence_against + case when p_outcome = 'refuted'   then 1 else 0 end
   where id = v_primary and account_id = v_account;

  -- Снятие — не по среднему, а по накопленным свидетельствам: пять неудач подряд против одного
  -- слабого коррелированного наблюдения не должны весить одинаково.
  update public.org_claims
     set status = 'retired'
   where id = v_primary and account_id = v_account and status = 'active'
     and evidence_against >= 5 and confidence < 0.300;

  return jsonb_build_object('applied', true, 'learned', true, 'claim_id', v_primary);
end;
$$;

revoke all on function public.org_decision_resolve(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_resolve(uuid, text, jsonb) to service_role;

-- ─── 20260807260000_org_memory_owner.sql ─────────────────────────────────────────────────────
-- Экран владельца: разрешение спора и достройка векторов.
--
-- Память, которую нельзя исправить, хуже отсутствующей: система верит во что-то, действует по
-- этому и не оставляет способа возразить. Отзыв у владельца уже был (org_claim_retire); не
-- хватало двух вещей — способа разрешить спор и гарантии, что сказанное владельцем вообще будет
-- найдено при отзыве.

-- Спор — это состояние, в которое система переводит два несовместимых вывода агентов, вместо того
-- чтобы молча выбрать один. Разрешает его человек: выбранное становится активным, а остальные
-- утверждения того же спора снимаются — иначе «разрешение» оставляло бы противоречие на месте.
create or replace function public.org_claim_affirm(p_claim_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid := public.current_account_id();
  v_kind    text;
  v_subject text;
  v_retired int := 0;
begin
  if v_account is null then
    raise exception using errcode = '42501', message = 'not authenticated';
  end if;

  update public.org_claims
     set status = 'active',
         source_detail = source_detail || jsonb_build_object('affirmed_by', 'owner')
   where id = p_claim_id and account_id = v_account and status <> 'retired'
  returning kind, subject_key into v_kind, v_subject;

  if v_kind is null then
    return jsonb_build_object('affirmed', false, 'reason', 'not_found_or_retired');
  end if;

  update public.org_claims
     set status = 'retired',
         source_detail = source_detail || jsonb_build_object('retired_reason', 'спор разрешён владельцем в пользу другого утверждения')
   where account_id = v_account and id <> p_claim_id
     and status = 'disputed' and kind = v_kind and subject_key = v_subject;
  get diagnostics v_retired = row_count;

  return jsonb_build_object('affirmed', true, 'retired_rivals', v_retired);
end;
$$;

revoke all on function public.org_claim_affirm(uuid) from public, anon;
grant execute on function public.org_claim_affirm(uuid) to authenticated, service_role;

-- Утверждение без вектора невидимо для отзыва: match_org_claims фильтрует `embedding is not null`.
-- Слово владельца, потерявшееся из-за недоступного Supabase.ai, — худший вид потери, поэтому оно
-- записывается в любом случае, а вектор достраивается позже. Эта функция отдаёт очередь на
-- достройку; сам вектор считает воркер, у которого есть рантайм.
create or replace function public.org_claims_missing_embedding(p_limit int default 20)
returns table (id uuid, account_id uuid, statement text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.account_id, c.statement
    from public.org_claims c
   where c.embedding is null and c.status <> 'retired'
   order by c.created_at
   limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.org_claim_set_embedding(p_claim_id uuid, p_embedding public.vector(384))
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.org_claims set embedding = p_embedding
   where id = p_claim_id and embedding is null
  returning true;
$$;

revoke all on function public.org_claims_missing_embedding(int) from public, anon, authenticated;
grant execute on function public.org_claims_missing_embedding(int) to service_role;
revoke all on function public.org_claim_set_embedding(uuid, public.vector) from public, anon, authenticated;
grant execute on function public.org_claim_set_embedding(uuid, public.vector) to service_role;

create index if not exists org_claims_needs_embedding_idx
  on public.org_claims (created_at) where embedding is null and status <> 'retired';

comment on function public.org_claim_affirm(uuid) is
  'Владелец разрешает спор: выбранное становится активным, соперники по тому же предмету снимаются.';

-- ─── 20260807270000_commerce_decision_bridge.sql ─────────────────────────────────────────────
-- Мостик Commerce → память: принятая рекомендация становится проверяемой гипотезой.
--
-- До сих пор путь обучения был декоративным: решений никто не регистрировал, резолвер каждый час
-- честно возвращал нули, и все убеждения навсегда оставались на уверенности 0.5. Оказалось хуже —
-- статус 'accepted' существовал в схеме, но в него не переводила ни одна строка кода: принять
-- рекомендацию было физически нельзя.
--
-- Принятие и регистрация решения происходят ОДНОЙ транзакцией. Рекомендация, принятая без
-- решения, необучаема и молчит об этом — ровно тот декоративный путь, который мы и убираем.

-- Наблюдателю нужна цена: price_guard советует поднять её до минимально допустимой, и проверить
-- это можно только измерив цену. Метрика лежала в снимках всё это время.
create or replace function public.org_observe_metric(
  p_account_id uuid,
  p_metric     text,
  p_params     jsonb,
  p_after      timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sku     uuid := nullif(p_params->>'sku_id', '')::uuid;
  v_catalog uuid := nullif(p_params->>'catalog_id', '')::uuid;
  v_value   numeric;
  v_at      timestamptz;
begin
  if v_sku is not null then
    perform 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
     where s.id = v_sku and c.account_id = p_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account');
    end if;
  end if;
  if v_catalog is not null then
    perform 1 from public.commerce_catalogs c where c.id = v_catalog and c.account_id = p_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account');
    end if;
  end if;

  if p_metric = 'commerce.sku.stock_total' then
    select i.stock_total, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric = 'commerce.sku.sold_units_7d' then
    select i.sold_units_7d, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric = 'commerce.sku.price_tiyin' then
    select i.price_tiyin, i.observed_at into v_value, v_at
      from public.commerce_inventory_snapshots i
     where i.sku_id = v_sku and i.observed_at > p_after
     order by i.observed_at desc limit 1;

  elsif p_metric in ('commerce.catalog.sold_units_7d', 'commerce.catalog.skus_at_zero') then
    with slot as (
      select max(i.observed_slot) s
        from public.commerce_inventory_snapshots i
        join public.commerce_skus k on k.id = i.sku_id
       where k.catalog_id = v_catalog and i.observed_at > p_after
    )
    select case when p_metric = 'commerce.catalog.sold_units_7d'
                then sum(coalesce(i.sold_units_7d, 0))
                else count(*) filter (where coalesce(i.stock_total, 0) = 0) end,
           max(i.observed_at)
      into v_value, v_at
      from public.commerce_inventory_snapshots i
      join public.commerce_skus k on k.id = i.sku_id, slot
     where k.catalog_id = v_catalog and i.observed_slot = slot.s;

  else
    return jsonb_build_object('ok', false, 'reason', 'unknown_metric', 'metric', p_metric);
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'reason', 'no_observation_after_horizon');
  end if;
  return jsonb_build_object('ok', true, 'value', v_value, 'observed_at', v_at, 'metric', p_metric);
end;
$$;

revoke all on function public.org_observe_metric(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.org_observe_metric(uuid, text, jsonb, timestamptz) to service_role;

-- Гипотеза, которую проверяет каждое принятие. Одна на вид находки, а не на рекомендацию:
-- утверждение «наш совет о пополнении работает» проверяется всеми пополнениями сразу, и
-- свидетельства копятся на нём. Одно принятие ничего не доказывает, двадцать — доказывают.
create or replace function public.commerce_hypothesis_for(p_account_id uuid, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject   text;
  v_statement text;
  v_id        uuid;
begin
  if p_kind in ('stockout', 'reorder') then
    v_subject := 'commerce:restock';
    v_statement := 'Пополнение по сигналу Nemo выводит остаток из нуля к сроку поставки.';
  elsif p_kind = 'price_guard' then
    v_subject := 'commerce:pricing';
    v_statement := 'Пересмотр цены по сигналу Nemo поднимает её до минимально допустимой.';
  else
    return null;
  end if;

  select id into v_id from public.org_claims
   where account_id = p_account_id and subject_key = v_subject and status <> 'retired'
   order by created_at limit 1;
  if v_id is not null then return v_id; end if;

  -- Вектор не считаем: SQL не умеет. Утверждение до достройки не найдётся отзывом, и воркер
  -- достроит его в течение пяти минут — тот самый путь, что уже стоит для слова владельца.
  insert into public.org_claims (account_id, statement, kind, subject, subject_key, source, source_detail)
  values (p_account_id, v_statement, 'preference', v_subject, v_subject, 'agent',
          jsonb_build_object('origin', 'commerce_bridge'))
  returning id into v_id;
  return v_id;
end;
$$;

-- Принятие рекомендации.
--
-- Nemo по-прежнему ничего не пишет в Uzum: «принято» означает, что владелец берётся сделать это
-- сам. Проверяем не выполнение, а результат — остаток перестал быть нулевым, цена поднялась.
-- Поэтому согласование и исход остаются разными вещами даже здесь.
create or replace function public.commerce_accept_finding(p_account_id uuid, p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec       record;
  v_lead      int;
  v_claim     uuid;
  v_expected  jsonb;
  v_horizon   timestamptz;
  v_decision  jsonb;
begin
  select r.id, r.kind, r.status, r.sku_id, r.calculation, s.lead_time_days, s.title, s.external_sku
    into v_rec
    from public.commerce_recommendations r
    join public.commerce_skus s on s.id = r.sku_id
    join public.commerce_catalogs c on c.id = s.catalog_id
   where r.id = p_recommendation_id and c.account_id = p_account_id
   for update of r;

  if v_rec.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_rec.status <> 'open' then
    -- Повторное нажатие не создаёт второго решения: принятие идемпотентно по статусу.
    return jsonb_build_object('ok', false, 'reason', 'already_' || v_rec.status);
  end if;

  -- Нехватка данных — не решение, а пробел. Регистрировать её как гипотезу значит засорить
  -- леглер тем, из чего нельзя научиться.
  if v_rec.kind = 'missing_data' then
    return jsonb_build_object('ok', false, 'reason', 'not_actionable');
  end if;

  if v_rec.kind in ('stockout', 'reorder') then
    -- Срок поставки плюс трое суток на то, чтобы приход отразился в снимке. Без запаса решение
    -- измерялось бы ровно в день, когда товар ещё едет.
    v_lead := coalesce(v_rec.lead_time_days, 14) + 3;
    v_expected := jsonb_build_object('metric', 'commerce.sku.stock_total', 'op', '>', 'value', 0,
                                     'params', jsonb_build_object('sku_id', v_rec.sku_id));
  elsif v_rec.kind = 'price_guard' then
    v_lead := 7;
    v_expected := jsonb_build_object('metric', 'commerce.sku.price_tiyin', 'op', '>=',
                                     'value', coalesce((v_rec.calculation->>'min_selling_price_tiyin')::numeric, 0),
                                     'params', jsonb_build_object('sku_id', v_rec.sku_id));
  else
    return jsonb_build_object('ok', false, 'reason', 'unsupported_kind', 'kind', v_rec.kind);
  end if;

  v_horizon := now() + make_interval(days => v_lead);
  v_claim := public.commerce_hypothesis_for(p_account_id, v_rec.kind);

  update public.commerce_recommendations
     set status = 'accepted', updated_at = now()
   where id = p_recommendation_id and status = 'open';

  v_decision := public.org_decision_register(
    p_account_id, 'recommendation', p_recommendation_id,
    left(v_rec.kind || ': ' || coalesce(v_rec.title, v_rec.external_sku, 'товар'), 400),
    v_expected, v_horizon,
    case when v_claim is null then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('claim_id', v_claim, 'role', 'primary')) end,
    jsonb_build_object('bridge', 'commerce', 'kind', v_rec.kind)
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'horizon_at', v_horizon,
                            'hypothesis', v_claim, 'expected', v_expected);
end;
$$;

revoke all on function public.commerce_hypothesis_for(uuid, text) from public, anon, authenticated;
grant execute on function public.commerce_hypothesis_for(uuid, text) to service_role;
revoke all on function public.commerce_accept_finding(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commerce_accept_finding(uuid, uuid) to service_role;

comment on function public.commerce_accept_finding(uuid, uuid) is
  'Принятие и регистрация решения одной транзакцией: принятая рекомендация без решения '
  'необучаема и молчит об этом.';

-- ─── 20260808160000_sync_run_counts.sql ──────────────────────────────────────────────────────
-- Синк, который ничего не нашёл, должен сказать, что именно он видел.
--
-- Vita Market Plus стоит 55 часов без единого товара, при этом каждые четыре часа прогон
-- завершается со статусом completed и пустой ошибкой. Установлено, что Uzum отвечает 200 с
-- пустым списком: провал чтения воркер записал бы в last_sync_error и упал.
--
-- Дальше начиналась догадка. Строка фильтрует карточки по наличию идентификатора
-- (`filter((row) => row.sku)`), поэтому «Uzum не дал ни одной карточки» и «карточки пришли, но ни
-- у одной нет пригодного ключа» выглядят совершенно одинаково — ноль записанных SKU и никаких
-- следов. Первый случай — пустой магазин, второй — наш дефект разбора, и лечатся они по-разному.
alter table public.commerce_sync_runs
  add column if not exists fetched_rows integer,
  add column if not exists usable_rows  integer;

comment on column public.commerce_sync_runs.fetched_rows is
  'Сколько строк вернул Uzum до фильтрации. Отличает пустой магазин от карточек, которые мы не '
  'смогли разобрать.';
comment on column public.commerce_sync_runs.usable_rows is
  'Сколько строк дошло до записи. fetched > 0 при usable = 0 — это наш дефект, а не пустой магазин.';

-- ─── 20260808170000_commerce_empty_shop.sql ──────────────────────────────────────────────────
-- Подтверждённо пустой магазин — это не авария.
--
-- Владелец посмотрел кабинет 125704: товаров там действительно нет. Сторож при этом честно кричал
-- 77 часов, и был прав по своей логике — данных нет. Но «продавец ещё не завёл карточки» и
-- «синхронизация сломалась» требуют разного: первое — вежливой подсказки один раз, второе —
-- тревоги, пока не починят.
--
-- ПОЧЕМУ НЕ status = 'paused'. В воркере стоит комментарий, что статус намеренно остаётся
-- 'active': и очередь, и claim-RPC выбирают только активные каталоги, поэтому пауза выбросила бы
-- магазин из синхронизации НАВСЕГДА — включая тот день, когда продавец добавит первый товар.
-- Шесть пустых вызовов в сутки стоят дешевле, чем магазин, который никогда не оживёт сам.
-- Меняется суждение, а не наблюдение.
alter table public.commerce_catalogs
  add column if not exists empty_confirmed_at timestamptz,
  add column if not exists empty_notified_at  timestamptz;

comment on column public.commerce_catalogs.empty_confirmed_at is
  'Владелец подтвердил, что в кабинете нет товаров. Снимается автоматически, когда товары '
  'появятся: магазин, который опустел ПОСЛЕ того как торговал, — это уже новость.';
comment on column public.commerce_catalogs.empty_notified_at is
  'Когда владельцу один раз предложили добавить первые товары. Вторая такая подсказка — спам.';

-- Отзыв свежести отдаёт то, что нужно для суждения: пустой подтверждённо, пустой ещё нет, или
-- сломанный. Раньше все три выглядели одинаково — «данных нет».
--
-- Через drop, а не create or replace: набор возвращаемых колонок меняется, и Postgres такого
-- замещения не допускает. Обе операции в одной транзакции миграции, поэтому окна без функции нет.
drop function if exists public.commerce_catalog_freshness(uuid[]);

create function public.commerce_catalog_freshness(p_account_ids uuid[])
returns table (
  catalog_id uuid,
  owner_account_id uuid,
  catalog_name text,
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_observed_at timestamptz,
  last_sync_error text,
  stale_alerted_at timestamptz,
  empty_confirmed_at timestamptz,
  empty_notified_at timestamptz
)
language sql
stable
set search_path = ''
as $$
  select
    c.id,
    c.account_id,
    c.name,
    c.created_at,
    c.last_synced_at,
    (select max(s.observed_at)
       from public.commerce_inventory_snapshots s
       join public.commerce_skus k on k.id = s.sku_id
      where k.catalog_id = c.id),
    c.last_sync_error,
    c.stale_alerted_at,
    c.empty_confirmed_at,
    c.empty_notified_at
  from public.commerce_catalogs c
  where c.account_id = any(p_account_ids)
    and c.status = 'active'
  order by c.created_at, c.id
$$;

comment on function public.commerce_catalog_freshness(uuid[]) is
  'Свежесть каталога для сторожа: когда данные последний раз приходили, и отличается ли пустой '
  'магазин от сломанного.';

-- Владелец подтвердил 8 августа 2026, глядя в кабинет. Тревога снимается, наблюдение — нет.
update public.commerce_catalogs
   set empty_confirmed_at = now(),
       stale_alerted_at = null
 where external_shop_id = '125704' and status = 'active' and empty_confirmed_at is null;

-- ─── 20260808180000_org_metrics_registry.sql ─────────────────────────────────────────────────
-- Реестр метрик: что система умеет измерять — и о чём честно говорит, что не умеет.
--
-- Наблюдатель был цепочкой if/elsif в SQL: каждая новая сфера требовала правки функции, а список
-- измеримого нигде не existed как данные. Отсюда два следствия, оба плохие. Расширение упиралось
-- в переписывание кода, и — важнее — нельзя было объявить метрику, не соврав: либо она есть в
-- цепочке и считается, либо её нет и регистрация решения падает с 'unknown metric'. Третьего
-- состояния — «знаем о такой метрике, но канала данных под ней нет» — не существовало.
--
-- Теперь оно есть, и это единственный способ говорить о CRM, финансах и HR, не обещая измеримости.
create table if not exists public.org_metrics (
  key           text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  domain        text not null check (domain in ('commerce', 'support', 'crm', 'finance', 'marketing', 'hr')),
  label         text not null check (char_length(label) between 3 and 120),
  unit          text not null check (unit in ('units', 'tiyin', 'minutes', 'percent', 'count')),

  -- Кого измеряем: конкретный товар, каталог, диалог или аккаунт целиком.
  subject_kind  text check (subject_kind in ('sku', 'catalog', 'dialogue', 'account')),

  -- КАК читаем. Стратегия — это форма чтения, а не метрика: «последнее значение колонки X по
  -- субъекту», «сумма по свежему слоту». Метрика, попадающая в известную форму, добавляется одной
  -- строкой. Метрика принципиально новой формы требует кода — и это честный предел, а не «в один
  -- клик всё».
  read_strategy text,
  source_column text,   -- имя колонки, если стратегия читает колонку
  source_value  text,   -- значение фильтра, если стратегия считает строки по признаку

  -- Подключён ли реальный канал данных. Ложь здесь дороже всего: объявленная, но не подключённая
  -- метрика превратила бы громкий отказ при регистрации в тихое 'unmeasurable' через неделю.
  is_wired       boolean not null default false,
  unwired_reason text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Подключённая метрика обязана сказать, как её читать. Неподключённая — чего не хватает.
  -- Молчать не разрешено ни той, ни другой.
  constraint org_metrics_wired_is_readable check (
    (is_wired and read_strategy is not null and subject_kind is not null)
    or (not is_wired)
  ),
  constraint org_metrics_unwired_explains_itself check (
    (not is_wired and unwired_reason is not null and char_length(unwired_reason) >= 10)
    or is_wired
  )
);

alter table public.org_metrics enable row level security;

-- Реестр одинаков для всех арендаторов: это возможности платформы, а не данные аккаунта.
-- Владельцу его видно — иначе «система умеет измерять X» останется словами.
drop policy if exists org_metrics_read on public.org_metrics;
create policy org_metrics_read on public.org_metrics for select to authenticated using (true);
revoke insert, update, delete on public.org_metrics from anon, authenticated;

create index if not exists org_metrics_domain_idx on public.org_metrics (domain, is_wired);

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Наблюдатель поверх реестра
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Измеряем только по наблюдениям ПОСЛЕ горизонта: данные, собранные до решения, о его исходе
-- ничего не говорят, а измерить ими и назвать результатом — самый дешёвый способ получить
-- красивую точность ни о чём.
create or replace function public.org_observe_metric(
  p_account_id uuid,
  p_metric     text,
  p_params     jsonb,
  p_after      timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  m         public.org_metrics%rowtype;
  v_sku      uuid := nullif(p_params->>'sku_id', '')::uuid;
  v_catalog  uuid := nullif(p_params->>'catalog_id', '')::uuid;
  v_dialogue uuid := nullif(p_params->>'dialogue_id', '')::uuid;
  v_value   numeric;
  v_at      timestamptz;
begin
  select * into m from public.org_metrics where key = p_metric;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_metric', 'metric', p_metric);
  end if;
  if not m.is_wired then
    -- Не ошибка вызова и не свойство мира: под метрикой просто нет канала данных, и мы это знаем.
    return jsonb_build_object('ok', false, 'reason', 'metric_not_wired', 'metric', p_metric,
                              'detail', m.unwired_reason);
  end if;

  -- Принадлежность арендаторам проверяется здесь: функция security definer, RLS её не прикрывает.
  if v_sku is not null then
    perform 1 from public.commerce_skus s
      join public.commerce_catalogs c on c.id = s.catalog_id
     where s.id = v_sku and c.account_id = p_account_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account'); end if;
  end if;
  if v_catalog is not null then
    perform 1 from public.commerce_catalogs c where c.id = v_catalog and c.account_id = p_account_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account'); end if;
  end if;
  if v_dialogue is not null then
    perform 1 from public.dialogues d
      join public.agents a on a.id = d.agent_id
     where d.id = v_dialogue and a.account_id = p_account_id;
    if not found then return jsonb_build_object('ok', false, 'reason', 'subject_not_in_account'); end if;
  end if;

  if m.read_strategy in ('commerce_snapshot_latest', 'commerce_slot_sum', 'commerce_slot_count_zero')
     and m.source_column is null then
    return jsonb_build_object('ok', false, 'reason', 'metric_misconfigured', 'metric', p_metric);
  end if;

  -- Имя колонки приходит из таблицы, доступной только service_role, и всё равно проходит через
  -- format('%I'): экранирование идентификатора стоит одну функцию, а доверие к данным — нет.
  if m.read_strategy = 'commerce_snapshot_latest' then
    execute format(
      'select i.%I, i.observed_at from public.commerce_inventory_snapshots i
        where i.sku_id = $1 and i.observed_at > $2 order by i.observed_at desc limit 1',
      m.source_column)
      into v_value, v_at using v_sku, p_after;

  elsif m.read_strategy in ('commerce_slot_sum', 'commerce_slot_count_zero') then
    -- По самому свежему полному слоту: смешивать соседние слоты значит складывать разные моменты
    -- времени и выдавать сумму за состояние.
    execute format(
      'with slot as (
         select max(i.observed_slot) s from public.commerce_inventory_snapshots i
           join public.commerce_skus k on k.id = i.sku_id
          where k.catalog_id = $1 and i.observed_at > $2)
       select %s, max(i.observed_at)
         from public.commerce_inventory_snapshots i
         join public.commerce_skus k on k.id = i.sku_id, slot
        where k.catalog_id = $1 and i.observed_slot = slot.s',
      case when m.read_strategy = 'commerce_slot_sum'
           then format('sum(coalesce(i.%I, 0))', m.source_column)
           else format('count(*) filter (where coalesce(i.%I, 0) = 0)', m.source_column) end)
      into v_value, v_at using v_catalog, p_after;

  elsif m.read_strategy = 'support_first_response_minutes' then
    -- Сколько минут прошло от первого вопроса клиента до первого ответа. Считается только по
    -- ответам ПОСЛЕ горизонта — ответ, данный до решения, о решении ничего не говорит.
    with asked as (
      select min(created_at) at from public.messages
       where dialogue_id = v_dialogue and author = 'customer'
    )
    select extract(epoch from (min(r.created_at) - asked.at)) / 60, min(r.created_at)
      into v_value, v_at
      from public.messages r, asked
     where r.dialogue_id = v_dialogue and r.author = 'agent'
       and r.created_at >= asked.at and r.created_at > p_after
     group by asked.at;

  elsif m.read_strategy = 'support_status_count' then
    select count(*), max(d.updated_at) into v_value, v_at
      from public.dialogues d
      join public.agents a on a.id = d.agent_id
     where a.account_id = p_account_id and d.status = m.source_value and d.updated_at > p_after;
    -- Ноль диалогов в статусе — это измерение, а не отсутствие данных: считать его пропуском
    -- значило бы никогда не подтвердить «очередь разобрана».
    if v_value is not null then
      return jsonb_build_object('ok', true, 'value', v_value,
                                'observed_at', coalesce(v_at, now()), 'metric', p_metric);
    end if;

  else
    return jsonb_build_object('ok', false, 'reason', 'unknown_strategy', 'strategy', m.read_strategy);
  end if;

  if v_value is null then
    return jsonb_build_object('ok', false, 'reason', 'no_observation_after_horizon');
  end if;
  return jsonb_build_object('ok', true, 'value', v_value, 'observed_at', v_at, 'metric', p_metric);
end;
$$;

revoke all on function public.org_observe_metric(uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.org_observe_metric(uuid, text, jsonb, timestamptz) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Первое наполнение
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Commerce переезжает как есть: те же пять ключей, что уже работали в цепочке if/elsif.
insert into public.org_metrics (key, domain, label, unit, subject_kind, read_strategy, source_column, is_wired) values
  ('commerce.sku.stock_total',        'commerce', 'Остаток товара',              'units', 'sku',     'commerce_snapshot_latest', 'stock_total',   true),
  ('commerce.sku.sold_units_7d',      'commerce', 'Продано за 7 дней',           'units', 'sku',     'commerce_snapshot_latest', 'sold_units_7d', true),
  ('commerce.sku.price_tiyin',        'commerce', 'Цена на витрине',             'tiyin', 'sku',     'commerce_snapshot_latest', 'price_tiyin',   true),
  ('commerce.catalog.sold_units_7d',  'commerce', 'Продажи каталога за 7 дней',  'units', 'catalog', 'commerce_slot_sum',        'sold_units_7d', true),
  ('commerce.catalog.skus_at_zero',   'commerce', 'Товаров с нулевым остатком',  'count', 'catalog', 'commerce_slot_count_zero', 'stock_total',   true)
on conflict (key) do nothing;

-- Поддержка — второй подключённый домен. Данные не обильные (два диалога), но канал настоящий:
-- Telegram подключён, dialogues и messages пишутся. Это ровно то различие, ради которого реестр
-- и заводился: «мало данных» и «нет канала» — разные вещи.
insert into public.org_metrics (key, domain, label, unit, subject_kind, read_strategy, source_value, is_wired) values
  ('support.dialogue.first_response_minutes', 'support', 'Время первого ответа', 'minutes', 'dialogue', 'support_first_response_minutes', null,             true),
  ('support.account.awaiting_operator',       'support', 'Ждут оператора',       'count',   'account',  'support_status_count',            'needs_operator', true)
on conflict (key) do nothing;

-- Остальные сферы система знает по имени и честно говорит, чего не хватает. Ни одна из них не
-- пройдёт регистрацию решения, пока причина не исчезнет.
insert into public.org_metrics (key, domain, label, unit, is_wired, unwired_reason) values
  ('crm.deals.closed',            'crm',       'Закрытых сделок',        'count',   false, 'Нет канала: сделки живут во внешней CRM, а коннектор только пишет наружу и не читает обратно.'),
  ('crm.deals.conversion',        'crm',       'Конверсия в сделку',     'percent', false, 'Нет канала: воронка ведётся во внешней CRM, обратного чтения нет.'),
  ('finance.cashflow',            'finance',   'Денежный поток',         'tiyin',   false, 'Нет канала: банковские выписки и 1С не подключены.'),
  ('finance.unpaid_invoices_age', 'finance',   'Возраст дебиторки',      'count',   false, 'Нет канала: счета не заводятся в Nemo и не читаются извне.'),
  ('marketing.roas',              'marketing', 'Возврат на рекламу',     'percent', false, 'Нет канала: рекламные кабинеты не подключены, расходы неизвестны.'),
  ('marketing.cac',               'marketing', 'Стоимость привлечения',  'tiyin',   false, 'Нет канала: нужны и расходы на рекламу, и источник заявки — нет ни того, ни другого.'),
  ('hr.time_to_hire',             'hr',        'Срок закрытия вакансии', 'count',   false, 'Нет канала: вакансии и кандидаты в Nemo не ведутся.')
on conflict (key) do nothing;

comment on table public.org_metrics is
  'Что система умеет измерять. is_wired = false означает «знаем о метрике, канала данных нет» — '
  'единственный способ говорить о сфере, не обещая измеримости.';
comment on column public.org_metrics.read_strategy is
  'Форма чтения, а не метрика. Метрика известной формы добавляется строкой; принципиально новая '
  'форма требует кода — это честный предел расширения.';

-- ─── 20260808190000_register_refuses_unwired.sql ─────────────────────────────────────────────
-- Регистрация решения отказывает и на неподключённой метрике, не только на незнакомой.
--
-- Раньше проверялась одна причина — 'unknown_metric'. С появлением реестра возникла вторая:
-- метрика объявлена, система знает её по имени, но канала данных под ней нет. Если такую
-- пропустить, громкий отказ в момент регистрации превратится в тихое 'unmeasurable' через неделю,
-- и небрежность будет выглядеть свойством мира. Отказ должен звучать там, где его слышно.
create or replace function public.org_decision_register(
  p_account_id uuid,
  p_source     text,
  p_source_id  uuid,
  p_summary    text,
  p_expected   jsonb,
  p_horizon_at timestamptz,
  p_claims     jsonb default '[]'::jsonb,
  p_policy_ref jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_metric   text := p_expected->>'metric';
  v_probe    jsonb;
  v_reason   text;
  v_link     jsonb;
  v_primaries int := 0;
  v_claim    record;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  -- Проба на заведомо пустом окне: значение не нужно, нужен ответ, можно ли эту метрику измерить
  -- в принципе.
  v_probe := public.org_observe_metric(p_account_id, v_metric, coalesce(p_expected->'params', '{}'::jsonb), now() + interval '100 years');
  v_reason := v_probe->>'reason';
  if v_reason = 'unknown_metric' then
    raise exception using errcode = '22023', message = 'unknown metric: ' || coalesce(v_metric, '(null)');
  end if;
  if v_reason = 'metric_not_wired' then
    raise exception using errcode = '22023',
      message = 'metric not wired: ' || coalesce(v_metric, '(null)') || ' — ' || coalesce(v_probe->>'detail', 'нет канала данных');
  end if;
  if v_reason = 'metric_misconfigured' or v_reason = 'unknown_strategy' then
    raise exception using errcode = '22023',
      message = 'metric misconfigured: ' || coalesce(v_metric, '(null)');
  end if;

  insert into public.org_decisions (account_id, source, source_id, summary, expected, horizon_at, policy_ref)
  values (p_account_id, p_source, p_source_id, p_summary, p_expected, p_horizon_at, coalesce(p_policy_ref, '{}'::jsonb))
  returning id into v_id;

  for v_link in select * from jsonb_array_elements(coalesce(p_claims, '[]'::jsonb))
  loop
    select c.id, c.confidence, c.statement into v_claim
      from public.org_claims c
     where c.id = (v_link->>'claim_id')::uuid and c.account_id = p_account_id;
    if not found then
      raise exception using errcode = '22023', message = 'claim not in account: ' || coalesce(v_link->>'claim_id', '(null)');
    end if;
    if coalesce(v_link->>'role', 'context') = 'primary' then
      v_primaries := v_primaries + 1;
    end if;
    insert into public.org_decision_claims (
      account_id, decision_id, claim_id, role, weight, confidence_at_decision, statement_hash
    ) values (
      p_account_id, v_id, v_claim.id,
      coalesce(v_link->>'role', 'context'),
      coalesce((v_link->>'weight')::numeric, 1.000),
      v_claim.confidence,
      md5(v_claim.statement)
    );
  end loop;

  return jsonb_build_object('id', v_id, 'claims', jsonb_array_length(coalesce(p_claims, '[]'::jsonb)),
                            'learnable', v_primaries = 1);
end;
$$;

revoke all on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) to service_role;

-- ─── 20260808200000_composite_expectations.sql ───────────────────────────────────────────────
-- Составное ожидание: пополнение засчитывается, только если товар ещё и продался.
--
-- Гипотеза пополнения проверялась одним условием — «остаток вышел из нуля». Ему удовлетворяет и
-- закупка, заморозившая деньги в неликвиде: товар лежит, остаток не ноль, гипотеза confirmed,
-- уверенность растёт. Система выучила бы, что её советы работают, не отличая выгодное пополнение
-- от разорительного.
--
-- Это та же лестная точность, против которой стоит правило про unmeasurable, — только пробравшаяся
-- с другой стороны: не через отсутствие метрики, а через её выбор. Метрика была измеримой и
-- честной; неверным был вопрос.
--
-- Теперь ожидание может быть конъюнкцией: {"all": [терм, терм]}. Одиночная форма продолжает
-- работать без изменений — цене второй вопрос не нужен.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Форма ожидания
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.org_term_well_formed(t jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(t) = 'object'
     and jsonb_typeof(t -> 'metric') = 'string'
     and (t ->> 'op') in ('>=', '>', '<=', '<', '==', '!=')
     and t ? 'value'
$$;

create or replace function public.org_expectation_well_formed(p jsonb)
returns boolean
language sql
immutable
as $$
  select case
    when jsonb_typeof(p) <> 'object' then false
    when p ? 'all' then
      jsonb_typeof(p -> 'all') = 'array'
      -- Верхняя граница не украшение: решение, зависящее от шести условий сразу, невозможно
      -- атрибутировать — не узнаешь, какое из них подвело.
      and jsonb_array_length(p -> 'all') between 1 and 4
      and not exists (
        select 1 from jsonb_array_elements(p -> 'all') t where not public.org_term_well_formed(t)
      )
    else public.org_term_well_formed(p)
  end
$$;

alter table public.org_decisions drop constraint if exists org_decisions_expected_measurable;
alter table public.org_decisions
  add constraint org_decisions_expected_measurable check (public.org_expectation_well_formed(expected));

-- Разворачивает ожидание в список термов: одиночное — сам себе список из одного.
create or replace function public.org_expectation_terms(p jsonb)
returns setof jsonb
language sql
immutable
as $$
  select case when p ? 'all' then t else p end
    from jsonb_array_elements(case when p ? 'all' then p -> 'all' else jsonb_build_array(p) end) t
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Резолвер по термам
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Неизмеримый терм делает неизмеримым всё решение. Заключить «сработало» по половине условий
-- нельзя: это и была бы та самая точность, созданная отбором.
create or replace function public.org_decisions_resolve_due(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due       record;
  v_term      jsonb;
  v_obs       jsonb;
  v_actual    numeric;
  v_target    numeric;
  v_holds     boolean;
  v_all_hold  boolean;
  v_blocked   jsonb;
  v_trace     jsonb;
  v_confirmed int := 0;
  v_refuted   int := 0;
  v_unmeasurable int := 0;
begin
  for v_due in
    select d.id, d.account_id, d.expected, d.horizon_at
      from public.org_decisions d
     where d.outcome = 'pending' and d.horizon_at <= now()
     order by d.horizon_at
     limit greatest(1, least(p_limit, 500))
     for update skip locked
  loop
    v_all_hold := true;
    v_blocked := null;
    v_trace := '[]'::jsonb;

    for v_term in select * from public.org_expectation_terms(v_due.expected)
    loop
      v_obs := public.org_observe_metric(
        v_due.account_id, v_term->>'metric',
        coalesce(v_term->'params', '{}'::jsonb), v_due.horizon_at);

      if coalesce((v_obs->>'ok')::boolean, false) is not true then
        v_blocked := v_obs || jsonb_build_object('metric', v_term->>'metric');
        exit;
      end if;

      v_target := (v_term->>'value')::numeric;
      v_actual := (v_obs->>'value')::numeric;
      v_holds := case v_term->>'op'
                   when '>='  then v_actual >= v_target
                   when '>'   then v_actual >  v_target
                   when '<='  then v_actual <= v_target
                   when '<'   then v_actual <  v_target
                   when '=='  then v_actual =  v_target
                   when '!='  then v_actual <> v_target
                 end;
      if v_holds is null then
        v_blocked := v_obs || jsonb_build_object('reason', 'unknown_operator', 'op', v_term->>'op');
        exit;
      end if;

      -- След по каждому терму: если решение опровергнуто, видно каким именно условием.
      v_trace := v_trace || jsonb_build_array(jsonb_build_object(
        'metric', v_term->>'metric', 'op', v_term->>'op',
        'expected', v_target, 'actual', v_actual, 'holds', v_holds));
      if not v_holds then v_all_hold := false; end if;
    end loop;

    if v_blocked is not null then
      perform public.org_decision_resolve(v_due.id, 'unmeasurable', v_blocked || jsonb_build_object('terms', v_trace));
      v_unmeasurable := v_unmeasurable + 1;
    elsif v_all_hold then
      perform public.org_decision_resolve(v_due.id, 'confirmed', jsonb_build_object('terms', v_trace));
      v_confirmed := v_confirmed + 1;
    else
      perform public.org_decision_resolve(v_due.id, 'refuted', jsonb_build_object('terms', v_trace));
      v_refuted := v_refuted + 1;
    end if;
  end loop;

  return jsonb_build_object('confirmed', v_confirmed, 'refuted', v_refuted, 'unmeasurable', v_unmeasurable);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Регистрация проверяет КАЖДЫЙ терм
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Иначе составное ожидание стало бы лазейкой: один подключённый терм рядом с неподключённым
-- прошёл бы регистрацию и вернулся тихим unmeasurable через неделю.
create or replace function public.org_decision_register(
  p_account_id uuid,
  p_source     text,
  p_source_id  uuid,
  p_summary    text,
  p_expected   jsonb,
  p_horizon_at timestamptz,
  p_claims     jsonb default '[]'::jsonb,
  p_policy_ref jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id       uuid;
  v_term     jsonb;
  v_metric   text;
  v_probe    jsonb;
  v_reason   text;
  v_link     jsonb;
  v_primaries int := 0;
  v_claim    record;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'account is required';
  end if;

  for v_term in select * from public.org_expectation_terms(p_expected)
  loop
    v_metric := v_term->>'metric';
    v_probe := public.org_observe_metric(p_account_id, v_metric, coalesce(v_term->'params', '{}'::jsonb), now() + interval '100 years');
    v_reason := v_probe->>'reason';
    if v_reason = 'unknown_metric' then
      raise exception using errcode = '22023', message = 'unknown metric: ' || coalesce(v_metric, '(null)');
    end if;
    if v_reason = 'metric_not_wired' then
      raise exception using errcode = '22023',
        message = 'metric not wired: ' || coalesce(v_metric, '(null)') || ' — ' || coalesce(v_probe->>'detail', 'нет канала данных');
    end if;
    if v_reason in ('metric_misconfigured', 'unknown_strategy') then
      raise exception using errcode = '22023', message = 'metric misconfigured: ' || coalesce(v_metric, '(null)');
    end if;
  end loop;

  insert into public.org_decisions (account_id, source, source_id, summary, expected, horizon_at, policy_ref)
  values (p_account_id, p_source, p_source_id, p_summary, p_expected, p_horizon_at, coalesce(p_policy_ref, '{}'::jsonb))
  returning id into v_id;

  for v_link in select * from jsonb_array_elements(coalesce(p_claims, '[]'::jsonb))
  loop
    select c.id, c.confidence, c.statement into v_claim
      from public.org_claims c
     where c.id = (v_link->>'claim_id')::uuid and c.account_id = p_account_id;
    if not found then
      raise exception using errcode = '22023', message = 'claim not in account: ' || coalesce(v_link->>'claim_id', '(null)');
    end if;
    if coalesce(v_link->>'role', 'context') = 'primary' then
      v_primaries := v_primaries + 1;
    end if;
    insert into public.org_decision_claims (
      account_id, decision_id, claim_id, role, weight, confidence_at_decision, statement_hash
    ) values (
      p_account_id, v_id, v_claim.id,
      coalesce(v_link->>'role', 'context'),
      coalesce((v_link->>'weight')::numeric, 1.000),
      v_claim.confidence,
      md5(v_claim.statement)
    );
  end loop;

  return jsonb_build_object('id', v_id, 'claims', jsonb_array_length(coalesce(p_claims, '[]'::jsonb)),
                            'learnable', v_primaries = 1);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Мостик Commerce спрашивает оба вопроса
-- ─────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.commerce_accept_finding(p_account_id uuid, p_recommendation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec       record;
  v_lead      int;
  v_claim     uuid;
  v_expected  jsonb;
  v_horizon   timestamptz;
  v_decision  jsonb;
begin
  select r.id, r.kind, r.status, r.sku_id, r.calculation, s.lead_time_days, s.title, s.external_sku
    into v_rec
    from public.commerce_recommendations r
    join public.commerce_skus s on s.id = r.sku_id
    join public.commerce_catalogs c on c.id = s.catalog_id
   where r.id = p_recommendation_id and c.account_id = p_account_id
   for update of r;

  if v_rec.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_rec.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'already_' || v_rec.status);
  end if;
  if v_rec.kind = 'missing_data' then
    return jsonb_build_object('ok', false, 'reason', 'not_actionable');
  end if;

  if v_rec.kind in ('stockout', 'reorder') then
    v_lead := coalesce(v_rec.lead_time_days, 14) + 3;
    -- ДВА вопроса, а не один. «Остаток вышел из нуля» верно и для закупки, заморозившей деньги в
    -- неликвиде. Совет о пополнении хорош тогда, когда товар лежит И продаётся.
    v_expected := jsonb_build_object('all', jsonb_build_array(
      jsonb_build_object('metric', 'commerce.sku.stock_total', 'op', '>', 'value', 0,
                         'params', jsonb_build_object('sku_id', v_rec.sku_id)),
      jsonb_build_object('metric', 'commerce.sku.sold_units_7d', 'op', '>', 'value', 0,
                         'params', jsonb_build_object('sku_id', v_rec.sku_id))
    ));
  elsif v_rec.kind = 'price_guard' then
    v_lead := 7;
    -- Цене второй вопрос не нужен: поднялась до минимума или нет — это и есть весь исход.
    v_expected := jsonb_build_object('metric', 'commerce.sku.price_tiyin', 'op', '>=',
                                     'value', coalesce((v_rec.calculation->>'min_selling_price_tiyin')::numeric, 0),
                                     'params', jsonb_build_object('sku_id', v_rec.sku_id));
  else
    return jsonb_build_object('ok', false, 'reason', 'unsupported_kind', 'kind', v_rec.kind);
  end if;

  v_horizon := now() + make_interval(days => v_lead);
  v_claim := public.commerce_hypothesis_for(p_account_id, v_rec.kind);

  update public.commerce_recommendations
     set status = 'accepted', updated_at = now()
   where id = p_recommendation_id and status = 'open';

  v_decision := public.org_decision_register(
    p_account_id, 'recommendation', p_recommendation_id,
    left(v_rec.kind || ': ' || coalesce(v_rec.title, v_rec.external_sku, 'товар'), 400),
    v_expected, v_horizon,
    case when v_claim is null then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('claim_id', v_claim, 'role', 'primary')) end,
    jsonb_build_object('bridge', 'commerce', 'kind', v_rec.kind)
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'horizon_at', v_horizon,
                            'hypothesis', v_claim, 'expected', v_expected);
end;
$$;

-- Формулировка гипотезы должна совпадать с тем, что теперь проверяется. Старая обещала только
-- выход из нуля, и оставить её значило бы измерять одно, а верить в другое.
update public.org_claims
   set statement = 'Пополнение по сигналу Nemo выводит остаток из нуля, и товар после этого продаётся.'
 where subject_key = 'commerce:restock' and status <> 'retired'
   and statement = 'Пополнение по сигналу Nemo выводит остаток из нуля к сроку поставки.';

create or replace function public.commerce_hypothesis_for(p_account_id uuid, p_kind text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject   text;
  v_statement text;
  v_id        uuid;
begin
  if p_kind in ('stockout', 'reorder') then
    v_subject := 'commerce:restock';
    v_statement := 'Пополнение по сигналу Nemo выводит остаток из нуля, и товар после этого продаётся.';
  elsif p_kind = 'price_guard' then
    v_subject := 'commerce:pricing';
    v_statement := 'Пересмотр цены по сигналу Nemo поднимает её до минимально допустимой.';
  else
    return null;
  end if;

  select id into v_id from public.org_claims
   where account_id = p_account_id and subject_key = v_subject and status <> 'retired'
   order by created_at limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.org_claims (account_id, statement, kind, subject, subject_key, source, source_detail)
  values (p_account_id, v_statement, 'preference', v_subject, v_subject, 'agent',
          jsonb_build_object('origin', 'commerce_bridge'))
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.org_decisions_resolve_due(int) from public, anon, authenticated;
grant execute on function public.org_decisions_resolve_due(int) to service_role;
revoke all on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.org_decision_register(uuid, text, uuid, text, jsonb, timestamptz, jsonb, jsonb) to service_role;
revoke all on function public.commerce_accept_finding(uuid, uuid) from public, anon, authenticated;
grant execute on function public.commerce_accept_finding(uuid, uuid) to service_role;
revoke all on function public.commerce_hypothesis_for(uuid, text) from public, anon, authenticated;
grant execute on function public.commerce_hypothesis_for(uuid, text) to service_role;

comment on function public.org_expectation_well_formed(jsonb) is
  'Ожидание — одиночный терм либо конъюнкция до четырёх. Больше нельзя: решение, зависящее от '
  'шести условий, невозможно атрибутировать.';

-- ─── 20260809160000_ops_controller.sql ───────────────────────────────────────────────────────
-- Операционный контролёр: закрывает то, что можно закрыть однозначно, и следит за остальным.
--
-- Роль задумывалась шире — «ведает учётом, чинит хвосты, будит кампанию». Проверка живой базы
-- показала, что чинить нечего: подвисших прогонов, заданий, решений и векторов ровно ноль, а
-- напоминание о себестоимости уже стоит в утренней сводке. Единственный настоящий пробел —
-- просроченные предложения: два висели в pending четыре дня, потому что фонового задания на них
-- нет вовсе.
--
-- Поэтому контролёр вышел узким, и это честный размер, а не урезанный. Он делает ровно две вещи:
-- закрывает просроченное и считает остальное, чтобы «сегодня всё чисто» перестало быть
-- предположением. Инварианты сегодня нули — но узнать об обратном было неоткуда.

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Что чинится однозначно
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Предложение с истёкшим сроком уже недействительно: apply_commerce_economics_proposal требует
-- expires_at > now(). Статус 'pending' у него — это не состояние, а забытая метка, и она врёт
-- владельцу в списке «ждёт вашей кнопки».
--
-- Ставится 'expired', а не 'rejected': владелец его не отклонял, у него вышло время. Ложный
-- ярлык в леджере — ровно то, от чего эта система избавляется.
create or replace function public.ops_sweep_stale()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_expired int;
begin
  update public.commerce_economics_proposals
     set status = 'expired'
   where status = 'pending' and expires_at < now();
  get diagnostics v_expired = row_count;
  return jsonb_build_object('proposals_expired', v_expired);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Что только считается
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Ни одна из этих категорий не чинится автоматически, и намеренно. У прогонов и заданий есть свои
-- лизы — вмешаться значило бы отобрать работу у живого воркера. Решение за горизонтом чинит
-- резолвер, вектор достраивает воркер памяти. Если счётчик перестал быть нулём, сломан ТОТ
-- механизм, и чинить надо его, а не последствие.
--
-- Истёкшие убеждения сюда не входят: отзыв их уже не видит, а на экране владельца они показаны
-- отдельным состоянием — это не долг, а история.
create or replace function public.ops_stuck_report()
returns table (kind text, stuck bigint, oldest_hours numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select 'proposals_overdue',
         count(*), round(max(extract(epoch from (now() - p.expires_at)) / 3600)::numeric, 1)
    from public.commerce_economics_proposals p
   where p.status = 'pending' and p.expires_at < now()
  union all
  select 'sync_runs_running',
         count(*), round(max(extract(epoch from (now() - r.claimed_at)) / 3600)::numeric, 1)
    from public.commerce_sync_runs r
   where r.status = 'running' and r.claimed_at < now() - interval '1 hour'
  union all
  select 'memory_jobs_processing',
         count(*), round(max(extract(epoch from (now() - o.claimed_at)) / 3600)::numeric, 1)
    from public.org_memory_outbox o
   where o.status = 'processing' and o.claimed_at < now() - interval '1 hour'
  union all
  select 'decisions_past_horizon',
         count(*), round(max(extract(epoch from (now() - d.horizon_at)) / 3600)::numeric, 1)
    from public.org_decisions d
   where d.outcome = 'pending' and d.horizon_at < now() - interval '2 hours'
  union all
  select 'claims_without_vector',
         count(*), round(max(extract(epoch from (now() - c.created_at)) / 3600)::numeric, 1)
    from public.org_claims c
   where c.embedding is null and c.status <> 'retired' and c.created_at < now() - interval '1 hour'
  union all
  select 'findings_open_over_week',
         count(*), round(max(extract(epoch from (now() - f.first_detected_at)) / 3600)::numeric, 1)
    from public.commerce_recommendations f
   where f.status = 'open' and f.first_detected_at < now() - interval '7 days';
$$;

revoke all on function public.ops_sweep_stale() from public, anon, authenticated;
grant execute on function public.ops_sweep_stale() to service_role;
revoke all on function public.ops_stuck_report() from public, anon, authenticated;
grant execute on function public.ops_stuck_report() to service_role;

comment on function public.ops_sweep_stale() is
  'Закрывает просроченные предложения. Единственное, что чинится однозначно: они уже недействительны, '
  'и pending у них — забытая метка, которая врёт владельцу.';
comment on function public.ops_stuck_report() is
  'Счётчики застрявшего. Ничего не чинит: у каждой категории есть свой механизм, и ненулевой '
  'счётчик означает поломку ТОГО механизма, а не необходимость убрать последствие.';

-- ─── 20260810120000_listing_description_blocks.sql ───────────────────────────────────────────
-- Описание карточки перестало быть абзацем.
--
-- Продающая карточка на Uzum состоит из четырёх блоков: крючок, введение, преимущества буллетами,
-- характеристики. Восьмисот символов на это не хватает — предел ставился под «1-3 предложения» и
-- вместе с ними же и устарел.
--
-- Предел остаётся: строка без границы однажды приедет мегабайтом от сломавшейся модели. Просто он
-- теперь описывает тот текст, который мы действительно хотим получить.
alter table public.commerce_listing_drafts
  drop constraint if exists commerce_listing_drafts_description_ru_check,
  drop constraint if exists commerce_listing_drafts_description_uz_check;

alter table public.commerce_listing_drafts
  add constraint commerce_listing_drafts_description_ru_check
    check (char_length(description_ru) <= 2200),
  add constraint commerce_listing_drafts_description_uz_check
    check (char_length(description_uz) <= 2200);

-- ─── 20260810130000_listing_owner_stated_fees.sql ────────────────────────────────────────────
-- Комиссия, названная владельцем, помечается как названная владельцем.
--
-- Полки берутся из категорий, где продавец УЖЕ торгует: там комиссию назвал сам Uzum, и она
-- факт. Товар из новой ниши такой полки не имеет — и до сих пор это значило, что минимальной
-- цены у него нет вовсе. Продавец, заходящий в новое направление, упирался в отказ на каждом
-- товаре.
--
-- Выход один: владелец берёт комиссию из справочника Uzum и называет её сам. Но тогда число
-- перестаёт быть фактом маркетплейса, и молчать об этом нельзя — иначе через неделю никто, включая
-- саму систему, не отличит подтверждённую комиссию от набранной руками. Тот же приём, что и с
-- себестоимостью: колонка провенанса рядом со значением.
alter table public.commerce_listing_drafts
  add column if not exists owner_stated_fields jsonb not null default '[]'::jsonb
  check (jsonb_typeof(owner_stated_fields) = 'array');

comment on column public.commerce_listing_drafts.owner_stated_fields is
  'Поля, значение которых назвал владелец, а не Uzum. Показываются на карточке знаком ≈.';

-- ─── 20260810140000_category_labels.sql ──────────────────────────────────────────────────────
-- Категории Uzum по-русски.
--
-- Uzum отдаёт ОДНО имя полки, узбекское: в товарном ответе есть `category` и нет ни `categoryRu`,
-- ни локали. Значит взять русское имя неоткуда, и «забирать оба языка при синхронизации» —
-- не вариант реализации, а несуществующая возможность.
--
-- Остаётся перевод. Он делается один раз на полку и кладётся сюда: у продавца их дюжина, у
-- платформы будут сотни, и переводить одно и то же на каждый рендер списка — трата и модели, и
-- времени владельца.
--
-- КЛЮЧОМ ОСТАЁТСЯ УЗБЕКСКОЕ ИМЯ. Оно приходит от Uzum, по нему сходятся товары, по нему
-- считается комиссия, оно лежит в черновиках. Перевод — только подпись на экране: полка,
-- сменившая имя из-за нового перевода, разошлась бы со своими же товарами.
create table if not exists public.commerce_category_labels (
  category   text primary key check (char_length(category) between 1 and 160),
  label_ru   text check (char_length(label_ru) between 1 and 160),
  label_en   text check (char_length(label_en) between 1 and 160),

  -- Кто назвал. Перевод модели можно молча заменить, слово владельца — нет.
  source     text not null default 'model' check (source in ('model', 'owner')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.commerce_category_labels enable row level security;

-- Справочник платформенный, а не арендаторский: полки Uzum одни и те же для всех продавцов, и
-- перевод, купленный на одном аккаунте, не должен покупаться заново на каждом следующем.
drop policy if exists commerce_category_labels_read on public.commerce_category_labels;
create policy commerce_category_labels_read on public.commerce_category_labels
  for select to authenticated using (true);
revoke insert, update, delete on public.commerce_category_labels from anon, authenticated;

-- ─── 20260810150000_commerce_deadstock.sql ───────────────────────────────────────────────────
-- Застрявший товар: лежит, платит за хранение и не продаётся.
--
-- Это не «ноль продаж за неделю» — такое бывает у сезонного товара в межсезонье и у новинки,
-- которую ещё никто не нашёл. Застой — это ДЛИТЕЛЬНОЕ отсутствие продаж при живом остатке, и
-- отличить одно от другого можно только историей.
--
-- Поэтому детектор молчит, пока истории мало. Соблазн велик: за пять дней наблюдений формально
-- «ноль продаж» верно почти у всего каталога, и отчёт вышел бы внушительный и бесполезный.
-- Порог в 14 дней наблюдений — то, что делает вывод проверяемым, а не громким.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_kind_check;
alter table public.commerce_recommendations
  add constraint commerce_recommendations_kind_check
  check (kind in ('reorder', 'price_guard', 'missing_data', 'stockout', 'deadstock'));

/*
 * Кто лежит без движения.
 *
 * sold_units_7d — скользящая семидневка от Uzum. Ноль на протяжении 14 дней наблюдений значит,
 * что продаж не было и в те семь дней, что предшествовали первому наблюдению: окно каждого
 * снимка заглядывает назад. Возвращается именно число НАБЛЮДАВШИХСЯ дней, а не разница дат:
 * пропущенная синхронизация не должна превращаться в «наблюдали, всё было плохо».
 */
create or replace function public.commerce_deadstock(
  p_catalog_id  uuid,
  p_window_days integer default 30,
  p_min_days    integer default 14
)
returns table (
  sku_id            uuid,
  stock_total       integer,
  price_tiyin       bigint,
  days_observed     integer,
  first_observed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with window_rows as (
    select
      s.sku_id,
      count(distinct date_trunc('day', s.observed_slot))::integer as days_observed,
      max(s.sold_units_7d)                                        as max_sold,
      min(s.observed_slot)                                        as first_observed_at
    from public.commerce_inventory_snapshots s
    join public.commerce_skus k on k.id = s.sku_id
    where k.catalog_id = p_catalog_id
      and s.observed_slot >= now() - make_interval(days => p_window_days)
    group by s.sku_id
  ),
  latest as (
    select distinct on (s.sku_id) s.sku_id, s.stock_total, s.price_tiyin
    from public.commerce_inventory_snapshots s
    join public.commerce_skus k on k.id = s.sku_id
    where k.catalog_id = p_catalog_id
    order by s.sku_id, s.observed_slot desc
  )
  select w.sku_id, l.stock_total, l.price_tiyin, w.days_observed, w.first_observed_at
  from window_rows w
  join latest l on l.sku_id = w.sku_id
  -- Остаток живой, продаж нет ни в одном наблюдении, и наблюдений достаточно, чтобы это значило
  -- застой, а не тишину коротких выходных.
  where coalesce(l.stock_total, 0) > 0
    and coalesce(w.max_sold, 0) = 0
    and w.days_observed >= p_min_days;
$$;

revoke all on function public.commerce_deadstock(uuid, integer, integer) from public, anon;
grant execute on function public.commerce_deadstock(uuid, integer, integer) to service_role;

-- ─── 20260810160000_commerce_accept_price.sql ────────────────────────────────────────────────
-- Владелец принял КОНКРЕТНУЮ цену, а не совет вообще.
--
-- commerce_accept_finding регистрирует «беру в работу» и ждёт, что цена станет не ниже пола.
-- Здесь ожидание жёстче и честнее: названо число, и через неделю проверяется именно оно. Разница
-- не косметическая — «цена выше пола» сбудется и когда владелец поставил пол, и когда он поставил
-- ровно то, что советовали, а это разные исходы с разной прибылью.
--
-- ПОЛ ПРОВЕРЯЕТСЯ ЗДЕСЬ, а не только в интерфейсе и не только в кнопке. Цена приходит из
-- callback_data или из набранного в чате числа — и то и другое владелец может изменить, а кнопку
-- ещё и переслать. Единственное место, где проверку нельзя обойти, — база.
create or replace function public.commerce_accept_price(
  p_account_id        uuid,
  p_recommendation_id uuid,
  p_price_tiyin       bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec      record;
  v_floor    numeric;
  v_claim    uuid;
  v_expected jsonb;
  v_horizon  timestamptz;
  v_decision jsonb;
begin
  select r.id, r.kind, r.status, r.sku_id, r.calculation, s.title, s.external_sku
    into v_rec
    from public.commerce_recommendations r
    join public.commerce_skus s on s.id = r.sku_id
    join public.commerce_catalogs c on c.id = s.catalog_id
   where r.id = p_recommendation_id and c.account_id = p_account_id
   for update of r;

  if v_rec.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_rec.status <> 'open' then
    -- Повторное нажатие не создаёт второго решения.
    return jsonb_build_object('ok', false, 'reason', 'already_' || v_rec.status);
  end if;
  if v_rec.kind not in ('price_guard', 'deadstock') then
    return jsonb_build_object('ok', false, 'reason', 'unsupported_kind', 'kind', v_rec.kind);
  end if;

  v_floor := (v_rec.calculation->>'min_selling_price_tiyin')::numeric;
  if v_floor is null then
    -- Без пола принять цену нельзя: не с чем сравнивать, и «приняли» означало бы «согласились
    -- вслепую». Пол считается из себестоимости и комиссии — если его нет, нет и их.
    return jsonb_build_object('ok', false, 'reason', 'no_floor');
  end if;
  if p_price_tiyin is null or p_price_tiyin <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_price');
  end if;
  if p_price_tiyin < v_floor then
    return jsonb_build_object('ok', false, 'reason', 'below_floor',
                              'floor_tiyin', v_floor, 'price_tiyin', p_price_tiyin);
  end if;

  -- Неделя: цена меняется в кабинете в тот же день, а продажи по новой цене нужно ещё накопить.
  v_horizon := now() + make_interval(days => 7);
  v_expected := jsonb_build_object(
    'metric', 'commerce.sku.price_tiyin', 'op', '>=', 'value', p_price_tiyin,
    'params', jsonb_build_object('sku_id', v_rec.sku_id)
  );
  v_claim := public.commerce_hypothesis_for(p_account_id, 'price_guard');

  update public.commerce_recommendations
     set status = 'accepted', updated_at = now(),
         suggested_action = coalesce(suggested_action, '{}'::jsonb)
                            || jsonb_build_object('accepted_price_tiyin', p_price_tiyin)
   where id = p_recommendation_id and status = 'open';

  v_decision := public.org_decision_register(
    p_account_id, 'recommendation', p_recommendation_id,
    left('price: ' || coalesce(v_rec.title, v_rec.external_sku, 'товар')
         || ' → ' || round(p_price_tiyin / 100) || ' сум', 400),
    v_expected, v_horizon,
    case when v_claim is null then '[]'::jsonb
         else jsonb_build_array(jsonb_build_object('claim_id', v_claim, 'role', 'primary')) end,
    jsonb_build_object('bridge', 'commerce', 'kind', v_rec.kind, 'price_tiyin', p_price_tiyin)
  );

  return jsonb_build_object('ok', true, 'decision', v_decision, 'horizon_at', v_horizon,
                            'hypothesis', v_claim, 'price_tiyin', p_price_tiyin);
end;
$$;

revoke all on function public.commerce_accept_price(uuid, uuid, bigint) from public, anon, authenticated;
grant execute on function public.commerce_accept_price(uuid, uuid, bigint) to service_role;

-- ─── 20260810170000_price_advice_sent.sql ────────────────────────────────────────────────────
-- Ценовой совет с кнопками уходит ОДИН раз, а не каждое утро.
--
-- Своей отметки у него быть обязано: digest_sent_at ставится всей утренней сводке разом, а
-- alerted_at принадлежит критическим авариям. Без третьей отметки владелец получал бы одну и ту
-- же кнопку «Принять 58 750» каждый день, включая дни после того, как он её нажал.
alter table public.commerce_recommendations
  add column if not exists advice_sent_at timestamptz;

create index if not exists commerce_recommendations_advice_idx
  on public.commerce_recommendations (status, advice_sent_at)
  where advice_sent_at is null;

-- ─── 20260811120000_billing_subscriptions.sql ────────────────────────────────────────────────
-- Состояние доступа аккаунта. ТОЛЬКО состояние: ни платежей, ни провайдеров здесь нет.
--
-- Таблица транзакций и вебхуки Payme/Click ждут ревью Codex по правилу CLAUDE.md — на платёжном
-- контуре ошибка стоит денег клиента. Замку они не нужны: он спрашивает «оплачено ли», а не «чем
-- и когда заплатили».
create table if not exists public.billing_subscriptions (
  account_id     uuid primary key references public.accounts(id) on delete cascade,
  status         text not null default 'trial' check (status in ('trial', 'active', 'past_due', 'cancelled')),
  plan_code      text,
  trial_ends_at  timestamptz,
  paid_until     timestamptz,
  -- Кто именно заплатил. Заполнится, когда появится платёжный модуль; пока служит тем, что
  -- фиксирует: провайдер будет не один.
  provider       text check (provider in ('payme', 'click')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.billing_subscriptions enable row level security;

-- Владелец видит свой срок — иначе «истекло» станет для него новостью в момент отказа.
drop policy if exists billing_subscriptions_read on public.billing_subscriptions;
create policy billing_subscriptions_read on public.billing_subscriptions for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));

-- Писать может только сервер. Продлить себе подписку из браузера нельзя.
revoke insert, update, delete on public.billing_subscriptions from anon, authenticated;

-- Существующие аккаунты получают триал от даты СВОЕГО создания, а не от сегодняшнего дня. Иначе
-- выкат биллинга подарил бы три свежих дня всем, включая тех, кто зарегистрировался в июле.
insert into public.billing_subscriptions (account_id, status, trial_ends_at)
select a.id, 'trial', a.created_at + interval '3 days'
from public.accounts a
on conflict (account_id) do nothing;

-- ─── 20260811130000_listing_images_bucket.sql ────────────────────────────────────────────────
-- Приватный бакет для фотографий товара.
--
-- Приватный, а не публичный: фото нового товара — коммерческая тайна продавца до публикации, и
-- ссылка, которую можно угадать перебором, отдала бы его ассортимент кому угодно. Модель ходит за
-- картинкой по подписанному адресу, живущему минуты.
--
-- ВРЕМЕННЫЙ по смыслу: файл нужен ровно на время одной генерации. Уборка живёт отдельной задачей
-- (см. commerce_purge_listing_images ниже) — бакет, из которого никто не выносит мусор, растёт
-- молча и обнаруживается счётом за хранение.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-temp-images',
  'listing-temp-images',
  false,
  -- Восемь мегабайт: снимок с телефона проходит, а видео и сканы каталогов — нет.
  8 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Путь начинается с account_id — это и есть граница между арендаторами. Заголовок политики
-- сравнивает первый сегмент пути с аккаунтом пользователя, поэтому чужую папку не прочитать и
-- не пополнить, даже зная имя файла.
drop policy if exists listing_images_insert on storage.objects;
create policy listing_images_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'listing-temp-images'
    and (storage.foldername(name))[1] = (select u.account_id::text from public.users u where u.id = auth.uid())
  );

drop policy if exists listing_images_read on storage.objects;
create policy listing_images_read on storage.objects for select to authenticated
  using (
    bucket_id = 'listing-temp-images'
    and (storage.foldername(name))[1] = (select u.account_id::text from public.users u where u.id = auth.uid())
  );

drop policy if exists listing_images_delete on storage.objects;
create policy listing_images_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'listing-temp-images'
    and (storage.foldername(name))[1] = (select u.account_id::text from public.users u where u.id = auth.uid())
  );

/*
 * Уборка. Файл переживает генерацию на сутки — на случай повторной попытки — и удаляется.
 *
 * Сутки, а не час: владелец, у которого не получилось с первого раза, переделывает черновик в тот
 * же день, и заставлять его загружать фото заново значит наказывать за нашу же неудачу.
 */
create or replace function public.commerce_purge_listing_images(p_older_than interval default interval '1 day')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed integer;
begin
  with gone as (
    delete from storage.objects
    where bucket_id = 'listing-temp-images'
      and created_at < now() - p_older_than
    returning 1
  )
  select count(*) into v_removed from gone;
  return v_removed;
end;
$$;

revoke all on function public.commerce_purge_listing_images(interval) from public, anon, authenticated;
grant execute on function public.commerce_purge_listing_images(interval) to service_role;

-- ─── 20260812100000_telegram_inbound_log.sql ─────────────────────────────────────────────────
-- Что вообще приходит в вебхук. Форма сообщения, а не содержимое.
--
-- Три дня подряд фотография «не доходила», и отличить «Telegram не доставил» от «мы отбросили
-- раньше ветки» было нечем: tg_updates пишется только в очередной ветке, после нескольких ранних
-- выходов, а логи аналитики отстают на минуты и однажды уже заставили меня пять раз подряд
-- сказать владельцу неправду.
--
-- Эта таблица пишется ПЕРВЫМ действием после проверки подписи — до дедупа, до кнопок, до
-- очереди. Если строки нет, значит запроса не было. Другого толкования у пустоты здесь не
-- останется.
--
-- Содержимое не хранится: только флаги формы. Переписка владельца с ботом — его дело, и
-- диагностике достаточно знать, что пришло фото с подписью, а не что на нём написано.
create table if not exists public.tg_inbound_log (
  id          bigint generated always as identity primary key,
  channel_id  uuid not null references public.channels(id) on delete cascade,
  update_id   bigint,
  kind        text not null,
  has_photo   boolean not null default false,
  has_document boolean not null default false,
  has_voice   boolean not null default false,
  has_text    boolean not null default false,
  has_caption boolean not null default false,
  chat_id     text,
  received_at timestamptz not null default now()
);

create index if not exists tg_inbound_log_recent_idx on public.tg_inbound_log (received_at desc);

alter table public.tg_inbound_log enable row level security;
revoke all on public.tg_inbound_log from anon, authenticated;

-- Неделя. Диагностика, живущая вечно, превращается в свалку, а вопрос «дошло ли вчера» дольше
-- недели никто не задаёт.
create or replace function public.tg_inbound_log_purge(p_older_than interval default interval '7 days')
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.tg_inbound_log where received_at < pg_catalog.now() - p_older_than returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function public.tg_inbound_log_purge(interval) from public, anon, authenticated;
grant execute on function public.tg_inbound_log_purge(interval) to service_role;

-- ─── 20260812110000_billing_invoices.sql ─────────────────────────────────────────────────────
-- Счёт — то, за что заплатили. Транзакция — то, чем заплатили. Это разные вещи.
--
-- Первый вариант схемы обходился одной таблицей транзакций с уникальностью
-- (provider, provider_transaction_id). Codex показал, чего она не защищает, и это не теория:
--
--   • Две попытки оплаты в Click дают РАЗНЫЕ click_trans_id при одном merchant_trans_id. Обе
--     проходят уникальность, обе завершаются, обе продлевают подписку. Один платёж — два периода.
--   • Тот же счёт можно оплатить дважды: один раз через Payme, другой через Click. Уникальность,
--     заведённая внутри провайдера, о втором провайдере не знает ничего.
--   • Два ретрая одного PerformTransaction оба увидят «строка уже есть, значит успех» и оба
--     продлят срок. Идемпотентность СТРОКИ не есть идемпотентность НАЧИСЛЕНИЯ.
--
-- Поэтому появляется счёт: единица того, что куплено. Начисление привязано к нему и случается
-- ровно один раз, чем бы и сколько раз за него ни платили.
create table if not exists public.billing_invoices (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references public.accounts(id) on delete cascade,

  -- СНИМОК УСЛОВИЙ на момент выставления. Не ссылка на прайс: цена в справочнике завтра
  -- изменится, а покупатель заплатил по сегодняшней. Проверять сумму платежа надо против того,
  -- что он видел, а не против того, что стало.
  plan_code     text not null check (char_length(plan_code) between 1 and 40),
  amount_tiyin  bigint not null check (amount_tiyin > 0),
  currency      text not null default 'UZS' check (currency = 'UZS'),
  duration_days integer not null check (duration_days between 1 and 400),

  status        text not null default 'pending' check (status in ('pending', 'paid', 'cancelled', 'expired')),

  -- Единственная защита от двойного начисления. Не «признак оплаты», а отметка о том, что права
  -- УЖЕ выданы: только запрос, переводящий её из null, продлевает срок.
  entitlement_applied_at timestamptz,
  -- Что именно выдали. Без этого «продлили на месяц» — слова: при разборе спора нужно знать, до
  -- какой даты довели и от какой считали.
  applied_paid_until     timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Счёт, за который не заплатили, не должен ждать вечно: провайдер тоже закрывает свои.
  expires_at timestamptz not null default now() + interval '2 days',

  -- Выдали права — обязаны сказать, до какой даты. Одно без другого означает потерянную улику.
  constraint billing_invoices_applied_is_explained
    check ((entitlement_applied_at is null) = (applied_paid_until is null))
);

create index if not exists billing_invoices_account_idx on public.billing_invoices (account_id, created_at desc);
create index if not exists billing_invoices_open_idx on public.billing_invoices (status, expires_at) where status = 'pending';

alter table public.billing_invoices enable row level security;

-- Владелец видит свои счета: срок, сумма и статус — то, что он вправе проверить сам.
drop policy if exists billing_invoices_read on public.billing_invoices;
create policy billing_invoices_read on public.billing_invoices for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));
revoke insert, update, delete on public.billing_invoices from anon, authenticated;

/*
 * Условия счёта неизменны после выставления.
 *
 * Иначе защита по сумме бессмысленна: достаточно поправить amount_tiyin под пришедший платёж, и
 * проверка «сумма совпала» совпадёт с чем угодно. Менять разрешено только статус и отметки о
 * начислении — то есть ход исполнения, а не сам договор.
 */
create or replace function public.billing_invoices_freeze_terms()
returns trigger
language plpgsql
as $$
begin
  if new.account_id is distinct from old.account_id
     or new.plan_code is distinct from old.plan_code
     or new.amount_tiyin is distinct from old.amount_tiyin
     or new.currency is distinct from old.currency
     or new.duration_days is distinct from old.duration_days
  then
    raise exception 'invoice terms are immutable once issued (invoice %)', old.id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists billing_invoices_freeze on public.billing_invoices;
create trigger billing_invoices_freeze before update on public.billing_invoices
  for each row execute function public.billing_invoices_freeze_terms();

/*
 * Начисление прав по счёту. Ровно один раз, чем бы за него ни платили.
 *
 * Вся работа — в одной транзакции с блокировкой строки счёта. Два одновременных вызова: первый
 * берёт блокировку и переводит entitlement_applied_at из null, второй ждёт, видит уже
 * проставленную отметку и возвращает ТОТ ЖЕ результат, ничего не продлевая. Повтор — не ошибка:
 * провайдеры ретраят по протоколу, и ответ на ретрай обязан совпадать с ответом на оригинал.
 *
 * Арифметика срока:
 *   greatest(coalesce(paid_until, now()), now()) + N дней
 *
 * От now() всегда — крадёт остаток у того, кто продлил заранее: двадцать оставшихся дней плюс
 * тридцать купленных дали бы тридцать. От paid_until всегда — продлевает в прошлое тому, кто
 * вернулся после перерыва: платёж прошёл, а замок не открылся.
 */
create or replace function public.apply_invoice_entitlement(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_base    timestamptz;
  v_until   timestamptz;
begin
  select * into v_invoice from public.billing_invoices where id = p_invoice_id for update;

  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Уже начислено: возвращаем прежний ответ, не трогая срок. Это и есть точка, где ретрай
  -- перестаёт быть вторым платежом.
  if v_invoice.entitlement_applied_at is not null then
    return jsonb_build_object('ok', true, 'already_applied', true,
                              'paid_until', v_invoice.applied_paid_until,
                              'invoice_id', v_invoice.id);
  end if;

  if v_invoice.status = 'cancelled' or v_invoice.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'invoice_' || v_invoice.status);
  end if;

  -- Подписка блокируется тоже: два счёта одного аккаунта, начисляемые одновременно, иначе
  -- прочитали бы одно и то же paid_until и один затёр бы другой.
  insert into public.billing_subscriptions (account_id, status)
  values (v_invoice.account_id, 'trial')
  on conflict (account_id) do nothing;

  select greatest(coalesce(paid_until, pg_catalog.now()), pg_catalog.now())
    into v_base
    from public.billing_subscriptions
   where account_id = v_invoice.account_id
     for update;

  v_until := v_base + pg_catalog.make_interval(days => v_invoice.duration_days);

  update public.billing_subscriptions
     set status = 'active',
         paid_until = v_until,
         plan_code = v_invoice.plan_code,
         updated_at = pg_catalog.now()
   where account_id = v_invoice.account_id;

  update public.billing_invoices
     set status = 'paid',
         entitlement_applied_at = pg_catalog.now(),
         applied_paid_until = v_until
   where id = v_invoice.id and entitlement_applied_at is null;

  return jsonb_build_object('ok', true, 'already_applied', false,
                            'paid_until', v_until, 'invoice_id', v_invoice.id,
                            'granted_days', v_invoice.duration_days);
end;
$$;

revoke all on function public.apply_invoice_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.apply_invoice_entitlement(uuid) to service_role;

/*
 * Право на пробный период — за магазином, а не за почтой.
 *
 * Триал, привязанный к созданию аккаунта, обходится заведением новой почты каждые три дня: это
 * стоит ноль и повторяется бесконечно. Привязка к магазину Uzum поднимает цену обхода с «новый
 * ящик» до «другой настоящий магазин» и при этом не мешает никому из честных: свой магазин у
 * продавца один и тот же, под какой бы почтой он ни вошёл.
 */
create table if not exists public.billing_trial_claims (
  shop_id    text primary key check (char_length(shop_id) between 1 and 120),
  account_id uuid not null references public.accounts(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

create index if not exists billing_trial_claims_account_idx on public.billing_trial_claims (account_id);

alter table public.billing_trial_claims enable row level security;
revoke all on public.billing_trial_claims from anon, authenticated;

/*
 * Закрепляет магазин за аккаунтом. Первый успевший владеет им.
 *
 * Возвращает true, если магазин теперь за этим аккаунтом (и в том числе если был за ним раньше),
 * false — если он уже занят другим. Отказ здесь НЕ должен ломать подключение каталога: продавец
 * может подключать второй магазин, и это законно. Отказ означает лишь, что нового пробного
 * периода за этот магазин не будет.
 */
create or replace function public.claim_shop_trial(p_account_id uuid, p_shop_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if p_account_id is null or coalesce(p_shop_id, '') = '' then
    return false;
  end if;
  insert into public.billing_trial_claims (shop_id, account_id)
  values (p_shop_id, p_account_id)
  on conflict (shop_id) do nothing;

  select account_id into v_owner from public.billing_trial_claims where shop_id = p_shop_id;
  return v_owner = p_account_id;
end;
$$;

/*
 * Заслужил ли аккаунт пробный период.
 *
 * Аккаунт БЕЗ подключённого магазина триал получает: иначе новый продавец не смог бы даже
 * посмотреть продукт до подключения Uzum, а это первый экран онбординга.
 *
 * Аккаунт с магазином получает триал, только если магазин закреплён за ним. Магазин, уже
 * отработавший триал под другим аккаунтом, второго не даёт.
 */
create or replace function public.trial_allowed_for_account(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (
    select 1
      from public.commerce_catalogs c
      join public.billing_trial_claims t on t.shop_id = c.external_shop_id
     where c.account_id = p_account_id
       and t.account_id <> p_account_id
  );
$$;

revoke all on function public.claim_shop_trial(uuid, text) from public, anon, authenticated;
revoke all on function public.trial_allowed_for_account(uuid) from public, anon;
grant execute on function public.claim_shop_trial(uuid, text) to service_role;
grant execute on function public.trial_allowed_for_account(uuid) to service_role, authenticated;

-- Уже подключённые магазины закрепляются за своими аккаунтами: иначе первый же чужой аккаунт,
-- подключивший тот же магазин, отобрал бы у них право на триал.
insert into public.billing_trial_claims (shop_id, account_id, claimed_at)
select distinct on (c.external_shop_id) c.external_shop_id, c.account_id, c.created_at
from public.commerce_catalogs c
where coalesce(c.external_shop_id, '') <> ''
order by c.external_shop_id, c.created_at
on conflict (shop_id) do nothing;

-- ─── 20260812120000_invoice_sets_plan.sql ────────────────────────────────────────────────────
-- Оплата счёта должна давать и права, и квоты.
--
-- Замок на ИИ-функции читает billing_subscriptions, а лимиты по токенам и медиа — accounts.plan.
-- Это две разные оси, и до сих пор их заполняли разные системы: план ставил Stripe, подписку —
-- ничто. После Payme и Click получилось бы худшее из двух: замок открыт, а квоты остались
-- бесплатного тарифа, и клиент, заплативший вчера, упирается в лимит сегодня.
--
-- Счёт несёт plan_code с момента выставления, поэтому источник один и тот же — снимок условий.
create or replace function public.apply_invoice_entitlement(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_base    timestamptz;
  v_until   timestamptz;
begin
  select * into v_invoice from public.billing_invoices where id = p_invoice_id for update;

  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_invoice.entitlement_applied_at is not null then
    return jsonb_build_object('ok', true, 'already_applied', true,
                              'paid_until', v_invoice.applied_paid_until,
                              'invoice_id', v_invoice.id);
  end if;

  if v_invoice.status = 'cancelled' or v_invoice.status = 'expired' then
    return jsonb_build_object('ok', false, 'reason', 'invoice_' || v_invoice.status);
  end if;

  insert into public.billing_subscriptions (account_id, status)
  values (v_invoice.account_id, 'trial')
  on conflict (account_id) do nothing;

  select greatest(coalesce(paid_until, pg_catalog.now()), pg_catalog.now())
    into v_base
    from public.billing_subscriptions
   where account_id = v_invoice.account_id
     for update;

  v_until := v_base + pg_catalog.make_interval(days => v_invoice.duration_days);

  update public.billing_subscriptions
     set status = 'active',
         paid_until = v_until,
         plan_code = v_invoice.plan_code,
         updated_at = pg_catalog.now()
   where account_id = v_invoice.account_id;

  -- Квоты идут за подпиской. Тот же снимок, та же транзакция: план и срок не должны расходиться.
  update public.accounts
     set plan = v_invoice.plan_code
   where id = v_invoice.account_id;

  update public.billing_invoices
     set status = 'paid',
         entitlement_applied_at = pg_catalog.now(),
         applied_paid_until = v_until
   where id = v_invoice.id and entitlement_applied_at is null;

  return jsonb_build_object('ok', true, 'already_applied', false,
                            'paid_until', v_until, 'invoice_id', v_invoice.id,
                            'plan_code', v_invoice.plan_code,
                            'granted_days', v_invoice.duration_days);
end;
$$;

-- ─── 20260812130000_billing_transactions.sql ─────────────────────────────────────────────────
-- Транзакция — то, ЧЕМ заплатили. Счёт — то, ЗА ЧТО. Одна строка на попытку провайдера.
--
-- Начисление привязано к счёту и защищено там (entitlement_applied_at). Эта таблица нужна для
-- другого: помнить состояние конкретной попытки, чтобы отвечать провайдеру одинаково на повтор и
-- не создавать вторую транзакцию под тем же номером.
create table if not exists public.billing_transactions (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('payme', 'click')),

  -- Идентификатор ПРОВАЙДЕРА, не наш. У Payme это params.id, у Click — click_trans_id.
  provider_transaction_id text not null check (char_length(provider_transaction_id) between 1 and 120),

  invoice_id    uuid not null references public.billing_invoices(id) on delete restrict,
  account_id    uuid not null references public.accounts(id) on delete cascade,

  -- Сумма попытки. Хранится, чтобы повтор с изменившейся суммой был виден как чужая транзакция
  -- под знакомым номером, а не принят по старому успешному ответу.
  amount_tiyin  bigint not null check (amount_tiyin > 0),

  -- Состояния Payme: 1 создана, 2 выполнена, -1 отменена, -2 отменена после выполнения.
  -- Click живёт теми же числами: 1 после Prepare, 2 после Complete.
  state         integer not null default 1 check (state in (1, 2, -1, -2)),

  -- Своя часть Click: merchant_prepare_id, которым Complete связывается со своим Prepare.
  merchant_prepare_id text,

  cancel_reason integer,
  created_at    timestamptz not null default now(),
  performed_at  timestamptz,
  cancelled_at  timestamptz,

  -- Повтор запроса не создаёт вторую строку. Это ответ на ретраи провайдера, а НЕ защита от
  -- двойного начисления: двойное начисление ловится на счёте, потому что двух разных транзакций
  -- на один счёт эта уникальность не запрещает.
  unique (provider, provider_transaction_id)
);

create index if not exists billing_transactions_invoice_idx on public.billing_transactions (invoice_id);
create index if not exists billing_transactions_account_idx on public.billing_transactions (account_id, created_at desc);

-- ОДИН СЧЁТ — ОДНА ВЫПОЛНЕННАЯ ТРАНЗАКЦИЯ.
--
-- Вот та защита, которой уникальность по провайдеру не даёт: две попытки Click с разными
-- click_trans_id по одному счёту, или оплата одного счёта и через Payme, и через Click. Частичный
-- уникальный индекс делает вторую выполненную транзакцию невозможной на уровне базы.
create unique index if not exists billing_transactions_one_performed_per_invoice
  on public.billing_transactions (invoice_id) where state = 2;

alter table public.billing_transactions enable row level security;

-- Владелец видит свои платежи: сумму, дату и состояние. Это его деньги.
drop policy if exists billing_transactions_read on public.billing_transactions;
create policy billing_transactions_read on public.billing_transactions for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));
revoke insert, update, delete on public.billing_transactions from anon, authenticated;

-- ─── 20260813090000_billing_numeric_ids.sql ──────────────────────────────────────────────────
-- Номер счёта и номер платежа — числами.
--
-- Не косметика. Click в своём протоколе работает целыми числами: merchant_trans_id он кладёт в
-- поле заказа, а merchant_prepare_id и merchant_confirm_id возвращает себе в журнал и сверяет как
-- числа. Uuid туда проходит по формату строки, но сертификацию не проходит, и на боевом контуре
-- это означает не «некрасиво», а «касса не подключится».
--
-- Второе, ради чего это стоит делать даже без Click: номер счёта видит человек. «Оплатите счёт
-- 100042» произносится по телефону и сверяется в выписке, а
-- «9329393e-b5ab-4f20-8b8f-ead0ad466148» — нет.
--
-- Uuid остаётся первичным ключом и внутренней ссылкой: он не угадывается перебором, и по нему
-- по-прежнему связаны все внешние ключи. Номер — вторая, публичная координата той же строки.

-- Начинаем с шестизначного: номера 1, 2, 3 выглядят как тестовые и в разговоре с покупателем
-- звучат так же.
create sequence if not exists public.billing_invoice_no_seq start with 100000;
create sequence if not exists public.billing_transaction_no_seq start with 100000;

alter table public.billing_invoices  add column if not exists invoice_no     bigint;
alter table public.billing_transactions add column if not exists transaction_no bigint;

alter table public.billing_invoices     alter column invoice_no     set default nextval('public.billing_invoice_no_seq');
alter table public.billing_transactions alter column transaction_no set default nextval('public.billing_transaction_no_seq');

alter sequence public.billing_invoice_no_seq     owned by public.billing_invoices.invoice_no;
alter sequence public.billing_transaction_no_seq owned by public.billing_transactions.transaction_no;

-- Строки, выставленные до этой миграции, получают номера тем же счётчиком. Пропуск оставил бы
-- счета без публичной координаты, и поиск по номеру молча не находил бы половину.
update public.billing_invoices     set invoice_no     = nextval('public.billing_invoice_no_seq')     where invoice_no is null;
update public.billing_transactions set transaction_no = nextval('public.billing_transaction_no_seq') where transaction_no is null;

alter table public.billing_invoices     alter column invoice_no     set not null;
alter table public.billing_transactions alter column transaction_no set not null;

-- Уникальность обязательна: номер — то, по чему касса находит счёт. Два счёта под одним номером
-- означают платёж, зачисленный не туда.
create unique index if not exists billing_invoices_no_key     on public.billing_invoices (invoice_no);
create unique index if not exists billing_transactions_no_key on public.billing_transactions (transaction_no);

/*
 * merchant_prepare_id больше не выдумывается отдельно.
 *
 * Раньше на Prepare генерировался случайный uuid и клался в merchant_prepare_id — то есть у
 * транзакции было два идентификатора, ни один из которых Click не принимает как число. Теперь
 * подготовку связывает с завершением сам номер транзакции: он уже уникален, уже числовой и уже
 * принадлежит ровно этой строке.
 *
 * Колонка остаётся ради истории: удалять то, чем отвечали провайдеру, значит терять улику в споре.
 */
comment on column public.billing_transactions.merchant_prepare_id is
  'Историческое поле. С 13.08.2026 подготовку с завершением связывает transaction_no.';

-- ─── 20260813120000_commerce_sales_trend.sql ─────────────────────────────────────────────────
-- Находка нового вида: спрос упал или остановился.
--
-- Одно окно продаж не отличает медленный товар от умирающего. Два окна отличают, и это разные
-- дни для владельца: в первом случае делать нечего, во втором деньги лежат на складе, а покупатель
-- ушёл к соседу.
alter table public.commerce_recommendations
  drop constraint if exists commerce_recommendations_kind_check;

alter table public.commerce_recommendations
  add constraint commerce_recommendations_kind_check
  check (kind in ('reorder', 'price_guard', 'missing_data', 'stockout', 'deadstock', 'sales_trend'));

comment on constraint commerce_recommendations_kind_check on public.commerce_recommendations is
  'sales_trend — падение или остановка продаж по сравнению с предыдущей неделей. Считается '
  'вычитанием двух окон (7 и 14 дней) и НЕ выставляется, когда любое из окон обрезано '
  'постраничной выборкой: разность двух неполных чисел выглядит как обвал.';

-- ─── 20260813140000_listing_submissions.sql ──────────────────────────────────────────────────
-- Отправка карточки в Uzum: выключатель и журнал попыток.
--
-- Отправки пока нет — внешние адреса создания товара Uzum закрывает 403 для ключа продавца
-- (проверено: 200 на рабочих маршрутах чтения, 403 на девяти адресах создания). Всё, что здесь
-- заводится, — контур ВОКРУГ отправки: чем она включается, что о каждой попытке остаётся и что
-- владелец прочитает вместо «ошибка».
--
-- Заводится это до самой отправки намеренно. Журнал, дописанный после того, как отправка
-- заработала, не помнит первых попыток — а именно первые и разбирают, когда карточка не доехала.

-- Режим отправки живёт у пилота: это уже строка на аккаунт, где хранится состояние коммерции.
alter table public.commerce_pilots
  add column if not exists auto_submit_to_moderation boolean not null default true;

comment on column public.commerce_pilots.auto_submit_to_moderation is
  'true — «Полная автономия»: готовая карточка уходит на модерацию сама. false — «Ручной '
  'контроль»: владелец подтверждает каждую в один клик. Значение по умолчанию true выбрано '
  'владельцем продукта; оно показывается при первом запуске, а не обнаруживается постфактум.';

/*
 * Журнал попыток отправки.
 *
 * Одна строка на попытку, а не на черновик: попыток бывает несколько, и разбирать спор
 * «почему товар не появился» приходится именно по ним. Ответ площадки хранится ЦЕЛИКОМ в том
 * виде, в каком пришёл, — пересказ ответа своими словами теряет ровно ту деталь, ради которой
 * в журнал и заглядывают.
 */
create table if not exists public.commerce_listing_submissions (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.commerce_listing_drafts(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,

  -- Кто решил отправлять: тумблер или человек. Без этого нельзя отличить «автономия отправила
  -- не то» от «владелец отправил не то», а это разные разговоры.
  mode text not null check (mode in ('auto', 'manual')),
  -- Чем отправляли. Пока только официальный API; расширение появится здесь же, когда появится.
  transport text not null check (transport in ('uzum_api', 'extension')),

  -- refused — до площадки не дошли (не хватило данных, нет прав, замок подписки);
  -- failed — дошли, площадка отказала; sent — площадка приняла.
  status text not null check (status in ('refused', 'failed', 'sent')),
  http_status integer,
  -- Причина машинным словом: по ней считается статистика, не разбирая текст.
  reason text check (char_length(reason) <= 60),
  -- Ответ площадки как есть, обрезанный по длине, а не по смыслу.
  provider_response text check (char_length(provider_response) <= 4000),
  -- Что владелец увидел на экране. Хранится, чтобы через месяц не гадать, какими словами
  -- ему объяснили отказ.
  owner_message text check (char_length(owner_message) <= 600),

  external_product_id text check (char_length(external_product_id) <= 120),
  attempted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists commerce_listing_submissions_draft_idx
  on public.commerce_listing_submissions(draft_id, created_at desc);
create index if not exists commerce_listing_submissions_account_idx
  on public.commerce_listing_submissions(account_id, created_at desc);

alter table public.commerce_listing_submissions enable row level security;

-- Владелец видит свои попытки: это его товар и его отказы.
drop policy if exists commerce_listing_submissions_read on public.commerce_listing_submissions;
create policy commerce_listing_submissions_read on public.commerce_listing_submissions
  for select to authenticated
  using (account_id = (select u.account_id from public.users u where u.id = auth.uid()));
revoke insert, update, delete on public.commerce_listing_submissions from anon, authenticated;

/*
 * Отправленный черновик — отдельное состояние.
 *
 * 'ready' означает «владелец одобрил», и это не то же самое, что «ушло на модерацию»: между ними
 * стоит площадка, которая может и отказать. Одно состояние на оба смысла привело бы к повторным
 * отправкам одной карточки — она же «ready».
 */
alter table public.commerce_listing_drafts
  drop constraint if exists commerce_listing_drafts_status_check;
alter table public.commerce_listing_drafts
  add constraint commerce_listing_drafts_status_check
  check (status in ('draft', 'ready', 'discarded', 'submitted'));

alter table public.commerce_listing_drafts
  add column if not exists submitted_at timestamptz;

-- Прежнее правило говорило «ready ровно тогда, когда есть approved_at». Отправленная карточка
-- тоже одобрена — иначе её бы не отправили, — поэтому правило переписано на оба состояния.
alter table public.commerce_listing_drafts
  drop constraint if exists commerce_listing_drafts_check;
alter table public.commerce_listing_drafts
  add constraint commerce_listing_drafts_approved_is_explained
  check ((status in ('ready', 'submitted')) = (approved_at is not null));

-- ─── 20260813160000_extension_submit.sql ─────────────────────────────────────────────────────
-- Перенос карточки через расширение браузера: свой тумблер и свои причины отказа.
--
-- Тумблер ОТДЕЛЬНЫЙ от auto_submit_to_moderation намеренно. Это разные способы с разным риском:
-- официальный API живёт по договору с площадкой, расширение работает вашей сессией в кабинете и,
-- скорее всего, противоречит правилам продавца. Один переключатель на оба означал бы, что человек,
-- включивший автономию по API, незаметно для себя включил и автоматизацию кабинета.
alter table public.commerce_pilots
  add column if not exists auto_extension_submit boolean not null default false;

comment on column public.commerce_pilots.auto_extension_submit is
  'Перенос карточек в кабинет Uzum через расширение браузера. По умолчанию ВЫКЛЮЧЕН: способ '
  'вероятно нарушает правила продавца Uzum, и включать его человек должен сам, а не обнаружить '
  'включённым. Не путать с auto_submit_to_moderation — это официальный API.';

/*
 * Причины, с которыми возвращается расширение.
 *
 * human_needed — увидели капчу или незнакомый экран и остановились. Это ОТКАЗ, а не поломка:
 *   карточка цела, решение за владельцем.
 * form_changed — разметка кабинета разошлась с нашей: поле или кнопка не найдены.
 * selectors_missing — разметка ещё не заполнена вовсе.
 *
 * Хранятся в том же журнале, что и попытки через API. Две таблицы дали бы две несходящиеся
 * статистики «сколько карточек доехало», и складывать их пришлось бы руками.
 */
comment on column public.commerce_listing_submissions.reason is
  'Причина машинным словом. От API: no_write_access, provider_rejected, provider_unavailable, '
  'incomplete, not_ready, already_submitted, subscription_locked, no_key, not_owner. '
  'От расширения: human_needed, form_changed, selectors_missing.';

-- ─── 20260817120000_sdr_leads.sql ────────────────────────────────────────────────────────────
-- Хранилище лидов SDR-пайплайна (agent-hub/sdr-run.mjs).
--
-- Внутренний инструмент продаж Ustudy IT, а не данные арендатора платформы: доступ только
-- сервисным ключом из доверенного CLI-скрипта. RLS включён БЕЗ единой политики для anon/
-- authenticated намеренно — как и у прочих инфраструктурных таблиц этого проекта (worker lease
-- и подобные): нет политики значит нет доступа никому, кроме service_role.

create table if not exists public.sdr_leads (
  id uuid primary key default gen_random_uuid(),
  place_id text not null,
  dedupe_key text not null unique,
  name text not null,
  normalized_name text not null,
  city text not null,
  address text,
  phone text,
  website text,
  rating numeric,
  reviews integer,
  operational boolean not null default true,
  enrichment jsonb not null default '{}'::jsonb,
  score jsonb,
  found_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sdr_leads_dedupe_key_idx on public.sdr_leads (dedupe_key);
-- Статус лежит внутри score (jsonb), а не отдельной колонкой: он выводится из числа на стороне
-- кода (schemas.ts:statusFor), и хранить его дважды означало бы держать два источника истины.
create index if not exists sdr_leads_status_idx on public.sdr_leads (((score ->> 'status')));
create index if not exists sdr_leads_city_idx on public.sdr_leads (city);

alter table public.sdr_leads enable row level security;

create or replace function public.sdr_leads_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sdr_leads_set_updated_at on public.sdr_leads;
create trigger sdr_leads_set_updated_at
  before update on public.sdr_leads
  for each row execute function public.sdr_leads_touch_updated_at();

-- ─── 20260817180000_nemo_api_tokens_sdr_jobs.sql ─────────────────────────────────────────────
-- Платформенные токены Nemo и очередь задач SDR.
--
-- Здесь появляется ВТОРОЙ класс учётных данных рядом с сессией Supabase, и это главный риск всей
-- затеи: долгоживущий ключ, который машина носит с собой. Поэтому три решения приняты жёстко и
-- проверяются кодом, а не соглашением:
--
--   1. DENY BY DEFAULT. Токен не «принадлежит аккаунту и потому может всё» — он может РОВНО то, что
--      перечислено в allowed_actions. Пустой массив означает «ничего», а не «всё».
--   2. Токен НЕ ХРАНИТСЯ. В базе лежит HMAC-SHA256 от него с серверным перцем; сам токен виден
--      один раз при создании. Утечка дампа базы не даёт действующих ключей.
--   3. Собственный лимит частоты у КАЖДОГО токена, поверх подписки аккаунта. Подписка отвечает на
--      «вправе ли этот аккаунт», лимит токена — на «сколько может утёкший ключ до того, как его
--      заметят». Это разные вопросы, и одного ответа на оба недостаточно.
--
-- Все три таблицы — инфраструктура: RLS включён БЕЗ единой политики, доступ только service_role.

create table if not exists public.nemo_api_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- HMAC-SHA256 в hex. Уникален: два токена не могут дать один отпечаток, а поиск по нему —
  -- одно обращение по индексу, а не перебор таблицы на каждом запросе.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Строгий белый список. Пустой массив = токен не может ничего: так безопаснее, чем «не указано
  -- значит всё», и позволяет отключить токен, не удаляя историю.
  allowed_actions text[] not null default '{}'::text[],
  rate_limit_per_minute integer not null default 30 check (rate_limit_per_minute between 1 and 600),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  -- Для ревокации по признаку «этим ключом давно не пользовались» и для аудита.
  last_used_at timestamptz
);

create index if not exists nemo_api_tokens_account_idx on public.nemo_api_tokens (account_id);

alter table public.nemo_api_tokens enable row level security;

-- Счётчик частоты. Отдельная таблица, а не поле в токене: минутные ведра позволяют считать
-- атомарно одним INSERT ... ON CONFLICT, без блокировки строки токена на каждый запрос.
create table if not exists public.nemo_api_token_usage (
  token_id uuid not null references public.nemo_api_tokens(id) on delete cascade,
  minute_bucket timestamptz not null,
  request_count integer not null default 0,
  primary key (token_id, minute_bucket)
);

alter table public.nemo_api_token_usage enable row level security;

/*
 * Атомарный расход лимита частоты.
 *
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING — единственная форма, которая одновременно
 * увеличивает счётчик и возвращает новое значение без гонки. Прочитать-потом-записать здесь
 * означало бы, что десять одновременных вызовов Edge Function увидят одно и то же число и все
 * решат, что лимит не исчерпан.
 */
create or replace function public.nemo_token_consume_rate(p_token_id uuid, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bucket timestamptz := date_trunc('minute', now());
  v_count integer;
begin
  insert into public.nemo_api_token_usage as u (token_id, minute_bucket, request_count)
  values (p_token_id, v_bucket, 1)
  on conflict (token_id, minute_bucket)
    do update set request_count = u.request_count + 1
  returning u.request_count into v_count;

  return v_count <= p_limit;
end
$$;

-- Ведра старше суток не нужны никому: лимит минутный, а история расхода живёт в аудите задач.
create or replace function public.nemo_token_usage_gc()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.nemo_api_token_usage where minute_bucket < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- ─────────────────────────────  Очередь задач SDR  ─────────────────────────────
--
-- Синхронный прогон здесь невозможен по существу, а не по неудобству: 30–50 лидов это запрос к
-- Overpass, N загрузок чужих сайтов и N вызовов модели — минуты работы, за которые Edge Function
-- успевает быть убитой по времени. Клиент получает job_id сразу, воркер работает отдельно.

create table if not exists public.sdr_jobs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  -- Каким токеном заведена задача. Нужно для аудита: по утёкшему ключу видно, что он успел создать.
  token_id uuid references public.nemo_api_tokens(id) on delete set null,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed')),
  params jsonb not null,
  -- Сколько кредитов списано при постановке. Хранится, чтобы вернуть РОВНО столько при провале.
  reserved_tokens bigint not null default 0,
  claim_token uuid,
  claimed_at timestamptz,
  -- Срок аренды: воркер, упавший молча, не должен держать задачу навсегда.
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  stats jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists sdr_jobs_account_idx on public.sdr_jobs (account_id, created_at desc);
create index if not exists sdr_jobs_queue_idx on public.sdr_jobs (status, created_at)
  where status in ('queued', 'running');

alter table public.sdr_jobs enable row level security;

-- Лиды, найденные задачей, привязываются к ней: иначе «прогон прошёл» и «вот его лиды» — два
-- несвязанных факта, и по job_id нельзя отдать результат.
alter table public.sdr_leads add column if not exists job_id uuid references public.sdr_jobs(id) on delete set null;
create index if not exists sdr_leads_job_idx on public.sdr_leads (job_id);

/*
 * Постановка задачи и списание кредитов ОДНОЙ транзакцией.
 *
 * Раздельно это две ошибки сразу: списали и не поставили — деньги за ничего; поставили и не
 * списали — бесплатный прогон в обход тарифа. Баланс аккаунта берётся FOR UPDATE, поэтому два
 * одновременных вызова не могут оба увидеть достаточный остаток.
 */
create or replace function public.enqueue_sdr_job(
  p_account_id uuid,
  p_token_id uuid,
  p_params jsonb,
  p_cost bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_job_id uuid;
begin
  if p_cost < 0 then raise exception 'invalid cost'; end if;

  select token_balance into v_balance from public.accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'account_not_found'); end if;

  if v_balance < p_cost then
    return jsonb_build_object('ok', false, 'error', 'insufficient_credits',
                              'balance', v_balance, 'required', p_cost);
  end if;

  update public.accounts set token_balance = token_balance - p_cost where id = p_account_id;

  insert into public.sdr_jobs (account_id, token_id, params, reserved_tokens)
  values (p_account_id, p_token_id, p_params, p_cost)
  returning id into v_job_id;

  return jsonb_build_object('ok', true, 'job_id', v_job_id, 'reserved', p_cost);
end
$$;

/*
 * Взять задачу в работу.
 *
 * FOR UPDATE SKIP LOCKED — тот же приём, что у остальных воркеров этого проекта: два воркера,
 * запущенные одновременно, разберут РАЗНЫЕ задачи, а не подерутся за одну. Задача с истёкшей
 * арендой возвращается в оборот: воркер мог быть убит между «взял» и «закончил».
 */
create or replace function public.claim_sdr_job(p_lease_seconds integer default 900)
returns setof public.sdr_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.sdr_jobs;
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  with candidate as (
    select id
    from public.sdr_jobs
    where attempts < 3
      and (
        status = 'queued'
        or (status = 'running' and lease_expires_at < now())
      )
    order by created_at
    for update skip locked
    limit 1
  )
  update public.sdr_jobs j
  set status = 'running',
      claim_token = gen_random_uuid(),
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      attempts = j.attempts + 1,
      updated_at = now()
  from candidate
  where j.id = candidate.id
  returning j.* into claimed;

  if claimed.id is not null then return next claimed; end if;
end
$$;

/** Продление аренды. Долгий прогон не должен выглядеть как умерший воркер. */
create or replace function public.heartbeat_sdr_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 900
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds, 900), 3600));
begin
  update public.sdr_jobs
  set lease_expires_at = now() + make_interval(secs => v_lease), updated_at = now()
  where id = p_job_id and claim_token = p_claim_token and status = 'running';
  return found;
end
$$;

/*
 * Завершение задачи. Кредиты за ПРОВАЛ возвращаются.
 *
 * Аренда проверяется по claim_token: воркер, у которого задачу уже отобрали по истечении срока,
 * не должен дописать свой результат поверх работы того, кто взял её после него.
 */
create or replace function public.finish_sdr_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_stats jsonb default null,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.sdr_jobs;
begin
  if p_status not in ('completed', 'failed', 'queued') then raise exception 'invalid status'; end if;

  select * into v_job from public.sdr_jobs
  where id = p_job_id and claim_token = p_claim_token and status = 'running'
  for update;
  if not found then return false; end if;

  -- Возврат только при окончательном провале. Возврат на каждой неудачной попытке означал бы, что
  -- три повтора списывают один раз, а возвращают трижды.
  if p_status = 'failed' and v_job.reserved_tokens > 0 then
    update public.accounts set token_balance = token_balance + v_job.reserved_tokens
    where id = v_job.account_id;
  end if;

  update public.sdr_jobs
  set status = p_status,
      stats = coalesce(p_stats, stats),
      error = p_error,
      claim_token = case when p_status = 'queued' then null else claim_token end,
      lease_expires_at = case when p_status = 'queued' then null else lease_expires_at end,
      finished_at = case when p_status in ('completed', 'failed') then now() else null end,
      updated_at = now()
  where id = p_job_id;

  return true;
end
$$;

create or replace function public.sdr_jobs_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sdr_jobs_set_updated_at on public.sdr_jobs;
create trigger sdr_jobs_set_updated_at
  before update on public.sdr_jobs
  for each row execute function public.sdr_jobs_touch_updated_at();

-- ─── 20260817200000_sdr_leads_crm_sync.sql ───────────────────────────────────────────────────
-- Отметка об отправке лида во внешнюю CRM.
--
-- Отдельная колонка, а не запись в журнал: журнал воркера живёт до перезапуска, а вопрос «этот лид
-- уже уехал в CRM или мы его теряли?» задают через неделю. Без отметки на это нечем ответить, и
-- единственный способ убедиться — отправить второй раз, то есть создать дубль у клиента.
--
-- Время, а не boolean: «отправлен» отвечает на меньше вопросов, чем «отправлен тогда-то», а места
-- занимает столько же.

alter table public.sdr_leads add column if not exists crm_synced_at timestamptz;

-- Индекс по НЕотправленным: именно их выбирают, чтобы дослать после падения приёмника. Частичный,
-- потому что отправленные со временем составят почти всю таблицу и в этом индексе не нужны.
create index if not exists sdr_leads_crm_pending_idx
  on public.sdr_leads (created_at)
  where crm_synced_at is null;

-- ─── 20260817220000_v5_core_schema.sql ───────────────────────────────────────────────────────
-- Ядро схемы V5: собственная телефония и двусторонняя связь с CRM.
--
-- Соответствует §5 спецификации «Nemo AI V5 (Full Production Edition)» с ОДНИМ обязательным
-- отступлением, о котором надо знать заранее.
--
-- ОТСТУПЛЕНИЕ ОТ ТЗ: `references tenants(id)` заменено на `references public.accounts(id)`.
-- Таблицы `tenants` в этой базе НЕТ и никогда не было: тенантом здесь служит `public.accounts`, на
-- неё указывают 63 внешних ключа во всех существующих миграциях. Написать `references tenants(id)`
-- буквально — значит получить отказ применения миграции на первой же строке. ИМЕНА КОЛОНОК при этом
-- сохранены как в ТЗ (`tenant_id`), чтобы Zod-контракты V5 и SQL совпадали поле в поле и между ними
-- не понадобился переходник.
--
-- ЧТО ЗДЕСЬ ХРАНЯТ СЕКРЕТЫ. `telephony_trunks.auth_password_encrypted` и
-- `crm_integrations.credentials_encrypted` — это пароль SIP-регистрации и токены доступа к чужой CRM.
-- Оба поля называются *_encrypted, и это ТРЕБОВАНИЕ, а не пожелание: колонка обязана получать уже
-- зашифрованное значение. База сама шифровать не умеет и проверить не может, поэтому ответственность
-- на том, кто пишет. Утечка первого даёт возможность звонить за счёт владельца, утечка второго — читать
-- и менять его сделки.
--
-- ИЗОЛЯЦИЯ ТЕНАНТОВ. У всех четырёх таблиц RLS включён, и у каждой есть политика по
-- `public.current_account_id()`. Это отличается от таблиц-очередей (`sdr_jobs`, `nemo_api_tokens`), где
-- RLS включён БЕЗ политик и доступ только у service_role: там данные принадлежат платформе, здесь —
-- владельцу аккаунта, и он должен видеть свои звонки в интерфейсе.
--
-- ЖУРНАЛ ЗВОНКОВ ПИШЕТ ТОЛЬКО СЕРВЕР. `telephony_calls` и `crm_sync_logs` доступны владельцу на
-- ЧТЕНИЕ и недоступны на запись: это аудит. Клиент, способный переписать длительность звонка или
-- статус синхронизации, превращает аудит в декорацию.

-- ── 1. SIP-транки ────────────────────────────────────────────────────────────────────────────────

create table if not exists public.telephony_trunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  -- CUSTOM_SIP — транк владельца (BYON), NEMO_RENTED — номер, арендованный у платформы. Разница не
  -- косметическая: за второй платит и отвечает платформа, и правила отключения у них разные.
  trunk_type varchar(20) not null check (trunk_type in ('CUSTOM_SIP', 'NEMO_RENTED')),
  name varchar(64) not null check (length(btrim(name)) between 2 and 64),
  sip_host varchar(255) not null check (length(btrim(sip_host)) > 0),
  sip_port int not null default 5060 check (sip_port between 1 and 65535),
  auth_username varchar(128) not null,
  -- Уже зашифрованное значение. Базе нечем это проверить — см. заголовок файла.
  auth_password_encrypted text not null,
  -- E.164. Регексп тот же, что в SIPTrunkConfigSchema: номер, не прошедший его, не примет ни один
  -- оператор, и узнать об этом на первом же исходящем звонке дороже, чем на вставке строки.
  caller_id varchar(32) not null check (caller_id ~ '^\+?[1-9][0-9]{1,14}$'),
  -- Сколько одновременных разговоров разрешено. Превышение у оператора стоит денег или блокировки
  -- транка целиком, поэтому предел хранится рядом с транком, а не в настройках приложения.
  max_channels int not null default 5 check (max_channels between 1 and 1000),
  status varchar(20) not null default 'ACTIVE'
    check (status in ('ACTIVE', 'REGISTRATION_FAILED', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Два транка с одинаковым именем у одного владельца — гарантированная путаница в интерфейсе выбора
  -- транка для звонка. Между разными владельцами имена не конфликтуют.
  constraint telephony_trunks_name_unique unique (tenant_id, name)
);

create index if not exists telephony_trunks_tenant_idx on public.telephony_trunks (tenant_id);
-- Частичный индекс: планировщик исходящих звонков ищет только годные транки, и держать в индексе
-- отключённые незачем.
create index if not exists telephony_trunks_active_idx
  on public.telephony_trunks (tenant_id) where status = 'ACTIVE';

alter table public.telephony_trunks enable row level security;

drop policy if exists telephony_trunks_tenant on public.telephony_trunks;
create policy telephony_trunks_tenant on public.telephony_trunks for all
  using (tenant_id = public.current_account_id())
  with check (tenant_id = public.current_account_id());

-- ── 2. Журнал звонков ────────────────────────────────────────────────────────────────────────────

create table if not exists public.telephony_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  -- ON DELETE RESTRICT, а не CASCADE: удаление транка НЕ должно уносить историю звонков по нему.
  -- Записи звонков — основание для счетов и для разбора жалоб, и терять их вместе с настройкой
  -- подключения нельзя.
  trunk_id uuid not null references public.telephony_trunks(id) on delete restrict,
  direction varchar(10) not null check (direction in ('INBOUND', 'OUTBOUND')),
  customer_phone varchar(32) not null,
  caller_id varchar(32) not null,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  -- Причина завершения от SIP (NORMAL_CLEARING, USER_BUSY, NO_ANSWER…). Единственный способ отличить
  -- «не взяли трубку» от «оператор отклонил» — без неё оба выглядят как звонок нулевой длины.
  sip_hangup_cause varchar(64),
  recording_url text,
  -- Полная расшифровка репликами. JSONB, а не текст: по ней ищут и её разбирают по ролям.
  full_transcript jsonb,
  -- Разбор звонка по CallAnalyticsSchema. Валидность структуры обеспечивает Zod ДО записи; база
  -- хранит проверенный документ и не дублирует проверку — иначе они разойдутся при первой правке схемы.
  analytics jsonb,
  created_at timestamptz not null default now()
);

create index if not exists telephony_calls_tenant_created_idx
  on public.telephony_calls (tenant_id, created_at desc);
create index if not exists telephony_calls_trunk_idx on public.telephony_calls (trunk_id);
-- Поиск истории по номеру клиента: «о чём мы с ним говорили в прошлый раз» — первый вопрос менеджера
-- перед повторным звонком.
create index if not exists telephony_calls_phone_idx
  on public.telephony_calls (tenant_id, customer_phone);

alter table public.telephony_calls enable row level security;

-- ТОЛЬКО ЧТЕНИЕ для владельца. Журнал звонков — аудит и основание для счёта; клиент, способный
-- переписать длительность или подменить расшифровку, обесценивает и то, и другое. Пишет service_role.
drop policy if exists telephony_calls_tenant_read on public.telephony_calls;
create policy telephony_calls_tenant_read on public.telephony_calls for select
  using (tenant_id = public.current_account_id());

-- ── 3. Интеграции с CRM ──────────────────────────────────────────────────────────────────────────

create table if not exists public.crm_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  provider varchar(20) not null check (provider in ('AMOCRM', 'HUBSPOT')),
  account_domain varchar(255) not null check (length(btrim(account_domain)) > 0),
  -- Токены доступа к чужой CRM, уже зашифрованные. JSONB, потому что у amoCRM и HubSpot разный набор
  -- полей (у первой long-lived token и subdomain, у второй access/refresh и portal id).
  credentials_encrypted jsonb not null,
  -- Соответствие «наш статус лида» → «стадия воронки в их CRM». Без него синхронизация складывает
  -- все сделки в первую попавшуюся стадию, и владелец видит кашу вместо воронки.
  stage_mappings jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Одна интеграция на провайдера у владельца: две записи для amoCRM означают два конкурирующих
  -- набора токенов, и какой из них применится — вопрос порядка строк.
  constraint unique_tenant_crm unique (tenant_id, provider)
);

create index if not exists crm_integrations_tenant_idx on public.crm_integrations (tenant_id);

alter table public.crm_integrations enable row level security;

drop policy if exists crm_integrations_tenant on public.crm_integrations;
create policy crm_integrations_tenant on public.crm_integrations for all
  using (tenant_id = public.current_account_id())
  with check (tenant_id = public.current_account_id());

-- ── 4. Аудит синхронизации ───────────────────────────────────────────────────────────────────────

create table if not exists public.crm_sync_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.accounts(id) on delete cascade,
  /*
   * КЛЮЧ ИДЕМПОТЕНТНОСТИ — главное в этой таблице, и UNIQUE здесь несёт логику, а не гигиену.
   *
   * Вебхуки CRM приходят повторно: amoCRM переспрашивает при таймауте, HubSpot дублирует при
   * повторной доставке, а наш исходящий вызов повторяется при сетевом сбое. Без уникального ключа
   * повторная доставка создаёт ВТОРУЮ сделку по тому же звонку — и менеджер звонит одному человеку
   * дважды. Уникальность на уровне базы — единственная защита, которая работает при нескольких
   * воркерах одновременно: проверка «а нет ли уже такой записи» перед вставкой проигрывает гонку.
   */
  idempotency_key varchar(128) not null unique check (length(btrim(idempotency_key)) > 0),
  provider varchar(20) not null check (provider in ('AMOCRM', 'HUBSPOT')),
  -- INBOUND — событие пришло от CRM, OUTBOUND — мы отправили в CRM. Одна таблица на оба направления
  -- намеренно: разбираются они всегда вместе, по одной сделке и в одном порядке времени.
  direction varchar(10) not null check (direction in ('INBOUND', 'OUTBOUND')),
  payload jsonb not null,
  status varchar(20) not null default 'PROCESSED'
    check (status in ('PROCESSED', 'FAILED', 'RETRYING')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists crm_sync_logs_tenant_created_idx
  on public.crm_sync_logs (tenant_id, created_at desc);
-- Частичный индекс под разбор незавершённого: строк со статусом RETRYING всегда мало, и держать в
-- индексе успешные (то есть почти все) незачем.
create index if not exists crm_sync_logs_retry_idx
  on public.crm_sync_logs (created_at) where status = 'RETRYING';

alter table public.crm_sync_logs enable row level security;

-- Аудит: владельцу видно, менять нельзя. Пишет service_role.
drop policy if exists crm_sync_logs_tenant_read on public.crm_sync_logs;
create policy crm_sync_logs_tenant_read on public.crm_sync_logs for select
  using (tenant_id = public.current_account_id());

-- ── Автоматическое updated_at ────────────────────────────────────────────────────────────────────
--
-- Триггером, а не значением по умолчанию: default срабатывает только на вставке, и строка, изменённая
-- через год, продолжала бы показывать дату создания. По этому полю решают, когда перепроверять
-- регистрацию транка.

create or replace function public.v5_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists telephony_trunks_set_updated_at on public.telephony_trunks;
create trigger telephony_trunks_set_updated_at
  before update on public.telephony_trunks
  for each row execute function public.v5_touch_updated_at();

drop trigger if exists crm_integrations_set_updated_at on public.crm_integrations;
create trigger crm_integrations_set_updated_at
  before update on public.crm_integrations
  for each row execute function public.v5_touch_updated_at();

-- ─── 20260822090000_bootstrap_admin_without_hardcoded_email.sql ──────────────────────────────
-- Убрать e-mail владельца из схемы и сделать выдачу первой админки явной операцией.
--
-- ЧТО БЫЛО. Триггер регистрации выдавал is_admin по совпадению с зашитым адресом:
--
--     insert into public.users (id, account_id, email, is_admin)
--     values (new.id, new_account, new.email, coalesce(new.email,'') = '<адрес владельца>');
--
-- Три беды сразу.
--
--   1. Адрес владельца лежит в схеме и уезжает в каждую копию платформы. Nemo — платформа, которую
--      разворачивают у себя; чужой e-mail в их базе не нужен никому.
--   2. Совпадение проверялось по НЕПОДТВЕРЖДЁННОМУ адресу. На установке с выключенным подтверждением
--      почты достаточно зарегистрироваться под этим адресом, чтобы стать администратором.
--   3. Выдача прав происходила молча, внутри триггера. По журналу видно регистрацию, а не то, что
--      вместе с ней выданы права на всю платформу.
--
-- ЧТО СТАЛО. Триггер больше НИКОГДА не выдаёт прав: is_admin = false для всех без исключения.
-- Первая админка выдаётся отдельным вызовом public.claim_platform_admin(uuid) — от владельца базы,
-- вручную, после подтверждения почты, и только пока администраторов нет вовсе.
--
-- ПОЧЕМУ НЕ ЧЕРЕЗ НАСТРОЙКУ current_setting('nemo.bootstrap_admin_email').
-- Это было первым замыслом, и он опаснее хардкода. Пользовательские параметры с незарегистрированным
-- префиксом в Postgres может выставить ЛЮБАЯ роль в своей сессии обычным SET/set_config, а
-- security definer меняет права выполнения, но сессионные параметры не сбрасывает. Проверка «адрес
-- совпал с параметром» превратилась бы в «адрес совпал с тем, что попросил сам заявитель».
--
-- СОВМЕСТИМОСТЬ. Строки public.users не трогаются: у кого админка есть — остаётся. Миграция
-- forward-only, ранее применённые не переписываются.

-- 1) Регистрация больше не раздаёт прав ----------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_account uuid;
  ref_code    text;
  ref_acc     uuid;
begin
  ref_code := upper(coalesce(new.raw_user_meta_data->>'ref', ''));
  insert into public.accounts (name, referral_code)
  values (coalesce(new.email, 'Nemo'), upper(substr(md5(new.id::text || random()::text), 1, 8)))
  returning id into new_account;

  -- is_admin ЯВНО false, а не «по умолчанию»: значение по умолчанию у столбца можно поменять
  -- следующей миграцией и не заметить, что вместе с ним поменялась выдача прав при регистрации.
  insert into public.users (id, account_id, email, is_admin)
  values (new.id, new_account, new.email, false);

  if ref_code <> '' then
    select id into ref_acc from public.accounts where referral_code = ref_code and id <> new_account limit 1;
    if ref_acc is not null then
      update public.accounts set referred_by = ref_acc where id = new_account;
    end if;
  end if;

  -- Подтверждённые при создании (OAuth) оплачиваются сразу, остальные — триггером подтверждения.
  if new.email_confirmed_at is not null then
    perform public.pay_referral_bonus(new_account);
  end if;

  return new;
end;
$$;

-- 2) Первая админка: один раз, вручную, по подтверждённой почте -----------------------------------

create or replace function public.claim_platform_admin(p_user_id uuid)
returns table (user_id uuid, email text, granted boolean, note text)
language plpgsql
security definer
set search_path = public
as $$
declare
  existing int;
  target   record;
begin
  /*
   * ЗАМОК ДО ПОДСЧЁТА.
   *
   * Без него два одновременных вызова оба увидят «администраторов нет» и выдадут права дважды —
   * ровно то, что эта функция обязана исключать. Вызвать её может только владелец функции, так что
   * гонка маловероятна, но «одноразовость» либо гарантируется, либо её нет.
   *
   * Именно advisory, а не lock table public.users: блокировать таблицу пользователей значит
   * останавливать регистрации на время начальной установки.
   */
  perform pg_advisory_xact_lock(hashtext('nemo.claim_platform_admin'));

  -- ОДИН РАЗ. Пока администратор есть, эта функция не выдаёт прав никому: дальше администраторов
  -- назначает администратор, а не процедура начальной установки. Иначе «bootstrap» остаётся вечно
  -- открытой дверью, о которой через полгода никто не помнит.
  select count(*) into existing from public.users where is_admin;
  if existing > 0 then
    return query select p_user_id, null::text, false,
      'администратор уже есть — назначайте через существующего администратора'::text;
    return;
  end if;

  select u.id, u.email, a.email_confirmed_at
    into target
    from public.users u
    join auth.users a on a.id = u.id
   where u.id = p_user_id;

  if not found then
    return query select p_user_id, null::text, false, 'пользователя нет'::text;
    return;
  end if;

  -- ТОЛЬКО ПОДТВЕРЖДЁННЫЙ АДРЕС. Неподтверждённый — это заявка, а не доказательство: на установке с
  -- выключенной проверкой почты назваться можно кем угодно.
  if target.email_confirmed_at is null then
    return query select p_user_id, target.email, false, 'почта не подтверждена'::text;
    return;
  end if;

  update public.users set is_admin = true where id = p_user_id;
  return query select p_user_id, target.email, true, 'выдано'::text;
end;
$$;

/*
 * ПРАВА НА ВЫЗОВ.
 *
 * Новая функция по умолчанию получает execute у PUBLIC — то есть у всех, включая anon. Поэтому
 * revoke from public здесь обязателен и идёт первым; перечисление ролей после него — на случай, если
 * какой-то из них право выдали отдельно.
 *
 * Останется он у ВЛАДЕЛЬЦА ФУНКЦИИ (роли, от имени которой прогоняются миграции — в Supabase это
 * postgres) и у суперпользователя. Не у service_role: он ходит из Edge Functions, то есть из кода,
 * который правится чаще, чем пересматриваются права.
 *
 * Повторный `create or replace` права НЕ сбрасывает — ACL сохраняется. А вот `drop` + `create`
 * вернёт execute к PUBLIC, и revoke придётся повторить. Контракт в agent-hub/auth-rls-contracts.mjs
 * воспроизводит grant/revoke по всем миграциям по порядку именно ради этого случая.
 */
revoke all on function public.claim_platform_admin(uuid) from public;
revoke all on function public.claim_platform_admin(uuid) from anon, authenticated, service_role;

comment on function public.claim_platform_admin(uuid) is
  'Начальная выдача админки. Вызывается владельцем функции (ролью миграций), только по подтверждённой почте, только пока администраторов нет. Порядок: пользователь регистрируется и подтверждает почту → select * from public.claim_platform_admin(''<uuid>'');';

-- ─── 20260822120000_waitlist_requests.sql ────────────────────────────────────────────────────
-- Заявки с публичных форм /waitlist и экрана входа («запросить доступ»).
-- До этой таблицы формы молча выбрасывали контакты: submit ставил флажок «отправлено»
-- и ничего никуда не записывал — потерянные лиды с собственного лендинга.
--
-- Доступ только через Edge Function `waitlist` (service role): RLS включён БЕЗ политик
-- (та же схема, что sdr_jobs), прямые гранты у anon/authenticated отозваны.
create table if not exists public.waitlist_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text not null,
  phone text,
  company text,
  leads text,
  note text,
  source text not null default 'waitlist',
  ip_hash text,
  created_at timestamptz not null default now(),
  constraint waitlist_requests_name_check check (name is null or char_length(name) <= 200),
  constraint waitlist_requests_email_check check (char_length(email) between 3 and 320),
  constraint waitlist_requests_phone_check check (phone is null or char_length(phone) <= 200),
  constraint waitlist_requests_company_check check (company is null or char_length(company) <= 200),
  constraint waitlist_requests_leads_check check (leads is null or char_length(leads) <= 200),
  constraint waitlist_requests_note_check check (note is null or char_length(note) <= 1000),
  constraint waitlist_requests_source_check check (source in ('waitlist', 'auth', 'pricing')),
  constraint waitlist_requests_ip_hash_check check (
    ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'
  )
);

alter table public.waitlist_requests enable row level security;
revoke all on table public.waitlist_requests from anon, authenticated;

create index if not exists waitlist_requests_ip_created_idx
  on public.waitlist_requests (ip_hash, created_at desc);
create index if not exists waitlist_requests_email_idx
  on public.waitlist_requests (lower(email));

-- Атомарный приём заявки: advisory-lock на ip_hash делает проверку лимита и вставку одной
-- операцией (count-then-insert двумя запросами обгоняется параллельными сабмитами).
-- Лимит совещательный: ip приходит из заголовка прокси и полностью надёжным не считается.
create or replace function public.waitlist_submit(
  p_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_leads text,
  p_note text,
  p_source text,
  p_ip_hash text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  recent int;
begin
  if p_email is null or char_length(p_email) not between 3 and 320 then
    raise exception using errcode = '22023', message = 'invalid email';
  end if;
  if p_source not in ('waitlist', 'auth', 'pricing') then
    raise exception using errcode = '22023', message = 'invalid source';
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid ip hash';
  end if;

  if p_ip_hash is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('waitlist:' || p_ip_hash, 0)
    );
  end if;
  -- Второй замок — на email: дедуп ниже иначе не атомарен для двух заявок с разных IP.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('waitlist-email:' || pg_catalog.lower(p_email), 0)
  );

  if p_ip_hash is not null then
    select count(*) into recent
      from public.waitlist_requests
      where ip_hash = p_ip_hash and created_at > pg_catalog.now() - interval '1 hour';
    if recent >= 5 then
      return 'rate_limited';
    end if;
  end if;

  -- Повторная отправка тем же email в течение суток — та же заявка (ретраи, двойной клик).
  if exists (
    select 1 from public.waitlist_requests
    where pg_catalog.lower(email) = pg_catalog.lower(p_email)
      and created_at > pg_catalog.now() - interval '24 hours'
  ) then
    return 'duplicate';
  end if;

  insert into public.waitlist_requests (name, email, phone, company, leads, note, source, ip_hash)
  values (p_name, p_email, p_phone, p_company, p_leads, p_note, p_source, p_ip_hash);
  return 'ok';
end;
$$;

revoke all on function public.waitlist_submit(text, text, text, text, text, text, text, text)
  from public, anon, authenticated;
-- revoke снял и дефолтный PUBLIC-грант — вернуть исполнение единственному законному вызывающему.
grant execute on function public.waitlist_submit(text, text, text, text, text, text, text, text)
  to service_role;

-- ─── 20260822140000_uzum_merchant.sql ────────────────────────────────────────────────────────
-- Касса Uzum Bank Merchant API v1.0.0.
--
-- ЧЕМ ЭТА КАССА ОТЛИЧАЕТСЯ ОТ PAYME И CLICK. У тех две фазы и один журнал —
-- billing_transactions. У Uzum четыре состояния (CREATED → CONFIRMED | REVERSED) и собственные
-- поля протокола: transTime, confirmTime, reverseTime, paymentSource, phone. Задание требует
-- отдельную таблицу под них, и это оправдано: складывать чужие поля в общий журнал значит
-- завести колонки, пустые у двух провайдеров из трёх.
--
-- НО ДЕНЕЖНЫЙ РЕЕСТР ОСТАЁТСЯ ОДИН. uzum_transactions — журнал ПРОТОКОЛА, billing_transactions —
-- реестр ПОПЫТОК ОПЛАТЫ, общий для всех касс. Обе строки создаются и меняются ОДНОЙ функцией в
-- одной транзакции: два последовательных запроса из Edge Function рано или поздно разойдутся —
-- сеть оборвётся между ними, — и тогда по одному журналу платёж есть, по другому нет.
--
-- НАЧИСЛЕНИЕ НЕ ПИШЕТСЯ ЗАНОВО. Права выдаёт apply_invoice_entitlement — та же функция, что у
-- Click и Payme: под блокировкой строки, идемпотентная, продлевающая от greatest(paid_until,
-- now()). Второй путь начисления означал бы вторую реализацию правила «месяц продлевается от
-- остатка, а не от сегодня», и разошлись бы они молча.
--
-- ORDER_ID — ЭТО НАШ INVOICE_NO. Ровно как merchant_trans_id у Click. Банк присылает номер
-- счёта, который покупатель видел; по нему сверяется сумма, срок и то, что счёт ещё не оплачен.

/* ─────────────────────────  Журнал протокола  ───────────────────────── */

create table if not exists public.uzum_transactions (
  id         uuid primary key default gen_random_uuid(),

  -- Идентификатор БАНКА. UUID в их протоколе, но хранится текстом: чужой формат идентификатора
  -- не наше дело, а uuid-колонка отвергла бы валидный для банка, но нестандартный для нас ключ.
  trans_id   text not null unique check (char_length(trans_id) between 1 and 120),

  -- То, что прислал банк в params.order_id. Хранится КАК ПРИШЛО, для разбора спора.
  order_id   text not null check (char_length(order_id) between 1 and 120),

  /*
   * Счёт, за который платят. НЕ NULL и restrict.
   *
   * Задание просило только account_id. Одного account_id мало: он говорит, чей это платёж, но не
   * говорит, за что. Без счёта нечего сверять — ни сумму, ни срок, ни то, что за него уже
   * заплатили, — и «оплата тарифа» сводится к «пришли деньги от этого аккаунта».
   */
  invoice_id uuid not null references public.billing_invoices(id) on delete restrict,
  account_id uuid not null references public.accounts(id) on delete cascade,

  -- В ТИЙИНАХ, как их присылает банк. Никаких пересчётов из сумов: Uzum, в отличие от Click,
  -- шлёт целое число тийинов, и умножение на сто здесь означало бы стократную сумму.
  amount     bigint not null check (amount > 0),

  status     text not null check (status in ('CREATED', 'CONFIRMED', 'REVERSED', 'FAILED')),
  service_id bigint not null,

  -- Отметки времени банка — epoch в миллисекундах, как в протоколе. Хранятся как пришли, чтобы
  -- ответ /status возвращал ровно то, что банк однажды получил.
  trans_time   bigint,
  confirm_time bigint,
  reverse_time bigint,

  payment_source text check (payment_source is null or char_length(payment_source) <= 60),
  phone          text check (phone is null or char_length(phone) <= 32),

  -- Тело запроса на создание. Именно create, а не последнее пришедшее: перезапись превратила бы
  -- улику в снимок последнего действия, а спорят обычно о том, с чего всё началось.
  raw_payload jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists uzum_transactions_invoice_idx on public.uzum_transactions (invoice_id);
create index if not exists uzum_transactions_account_idx on public.uzum_transactions (account_id, created_at desc);
create index if not exists uzum_transactions_order_idx on public.uzum_transactions (order_id);

/*
 * ОДНА ЖИВАЯ ТРАНЗАКЦИЯ НА СЧЁТ.
 *
 * unique(trans_id) не запрещает завести ВТОРУЮ транзакцию с другим transId на тот же счёт — а
 * это ровно тот случай, из-за которого в billing_invoices вообще появились счета: две попытки
 * оплаты, обе подтверждаются, один платёж даёт два периода. Начисление защищено на счёте, но
 * банк при этом получил бы два CONFIRMED и списал деньги дважды.
 *
 * Частичный: отменённые и провалившиеся не мешают заплатить снова.
 */
create unique index if not exists uzum_transactions_live_invoice_idx
  on public.uzum_transactions (invoice_id)
  where status in ('CREATED', 'CONFIRMED');

alter table public.uzum_transactions enable row level security;

/*
 * ЗАКРЫТА ПОЛНОСТЬЮ.
 *
 * Ни одной политики: при включённом RLS это означает «никому», а service_role RLS обходит. Так
 * же закрыт billing_transactions. Владельцу счета показывать здесь нечего — статус оплаты он
 * видит в billing_invoices, а телефон и источник платежа это данные банка, а не его кабинета.
 *
 * revoke сверх RLS не лишний: RLS не действует на владельца таблицы, и права выданные роли
 * напрямую пережили бы включение RLS незамеченными.
 */
revoke all on public.uzum_transactions from anon, authenticated;
grant all on public.uzum_transactions to service_role;

comment on table public.uzum_transactions is
  'Журнал протокола Uzum Bank Merchant API. Денежный реестр — billing_transactions, начисление — apply_invoice_entitlement.';

/* ─────────────────  Общий реестр знает о третьей кассе  ───────────────── */

alter table public.billing_transactions drop constraint if exists billing_transactions_provider_check;
alter table public.billing_transactions
  add constraint billing_transactions_provider_check check (provider in ('payme', 'click', 'uzum'));

alter table public.billing_subscriptions drop constraint if exists billing_subscriptions_provider_check;
alter table public.billing_subscriptions
  add constraint billing_subscriptions_provider_check check (provider is null or provider in ('payme', 'click', 'uzum'));

/* ─────────────────────  Отмена уже начисленного  ───────────────────── */

-- Отметка о том, что права ОТОБРАНЫ. Отдельная от entitlement_applied_at, а не обнуление её:
-- обнулив, мы сделали бы счёт снова оплачиваемым и стёрли улику о том, что деньги приходили.
alter table public.billing_invoices add column if not exists entitlement_revoked_at timestamptz;

/*
 * Обратная операция к apply_invoice_entitlement.
 *
 * ЗАЧЕМ ОНА ВООБЩЕ. Uzum умеет /reverse ПОСЛЕ /confirm — банк возвращает деньги покупателю. Если
 * оставить подписку продлённой, отмена платежа становится способом получить тариф бесплатно.
 *
 * ПОЧЕМУ ВЫЧИТАЕТСЯ duration_days, А НЕ ВОССТАНАВЛИВАЕТСЯ ПРЕЖНЯЯ ДАТА. Между начислением и
 * отменой мог пройти ещё один платёж. Вернув сохранённое «было до», мы отобрали бы и его. Сложение
 * дней коммутативно, поэтому вычесть ровно свои дни правильно при любом порядке событий.
 *
 * ПОЧЕМУ НЕ НИЖЕ now(). Отрицательный остаток — это долг, которого в подписке нет: замок либо
 * открыт, либо закрыт. Уводя дату в прошлое дальше сегодняшнего дня, мы создали бы аккаунт,
 * который не откроется даже после следующей оплаты, пока не «отработает» минус.
 */
create or replace function public.revoke_invoice_entitlement(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_until   timestamptz;
  v_plan    text;
begin
  select * into v_invoice from public.billing_invoices where id = p_invoice_id for update;
  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Повторная отмена ничего не отнимает второй раз.
  if v_invoice.entitlement_revoked_at is not null then
    return jsonb_build_object('ok', true, 'already_revoked', true, 'invoice_id', v_invoice.id);
  end if;

  -- Начисления не было — отменять нечего, счёт просто закрывается.
  if v_invoice.entitlement_applied_at is null then
    update public.billing_invoices
       set status = 'cancelled', entitlement_revoked_at = pg_catalog.now()
     where id = v_invoice.id;
    return jsonb_build_object('ok', true, 'already_revoked', false, 'granted_days', 0,
                              'invoice_id', v_invoice.id);
  end if;

  select pg_catalog.greatest(
           pg_catalog.now(),
           paid_until - pg_catalog.make_interval(days => v_invoice.duration_days)
         )
    into v_until
    from public.billing_subscriptions
   where account_id = v_invoice.account_id
     for update;

  if v_until is null then
    return jsonb_build_object('ok', false, 'reason', 'no_subscription');
  end if;

  -- Счёт закрывается ДО пересчёта тарифа: иначе он сам попадёт в выборку «какой тариф остался».
  update public.billing_invoices
     set status = 'cancelled', entitlement_revoked_at = pg_catalog.now()
   where id = v_invoice.id;

  /*
   * ТАРИФ ВОЗВРАЩАЕТСЯ К ПРЕДЫДУЩЕМУ ОПЛАЧЕННОМУ, А НЕ ОСТАЁТСЯ ОТМЕНЁННЫМ.
   *
   * Вычесть дни мало. Купили Starter, потом Business, Business вернули — дни сойдутся, а plan_code
   * останется Business, и покупатель продолжит пользоваться возможностями, за которые ему вернули
   * деньги. Берётся последний по времени начисления счёт, который начислен и НЕ отозван.
   *
   * Дни при этом вычитаются ровно свои: сложение коммутативно, поэтому порядок отмен на сумму
   * оставшихся дней не влияет.
   */
  select plan_code into v_plan
    from public.billing_invoices
   where account_id = v_invoice.account_id
     and entitlement_applied_at is not null
     and entitlement_revoked_at is null
   order by entitlement_applied_at desc
   limit 1;

  update public.billing_subscriptions
     set paid_until = v_until,
         /*
          * Срок кончился ровно сейчас — подписка больше не активна.
          *
          * Статус берётся из РАЗРЕШЁННОГО схемой набора (trial, active, past_due, cancelled).
          * Первая версия писала сюда 'expired' — значения, которого в ограничении нет, и возврат
          * подтверждённого платежа откатывался бы целиком на constraint violation. Проверка по
          * тексту такого не ловит: она видит слово, а не набор допустимых.
          */
         status = case when v_until <= pg_catalog.now() then 'cancelled' else 'active' end,
         plan_code = coalesce(v_plan, plan_code),
         updated_at = pg_catalog.now()
   where account_id = v_invoice.account_id;

  return jsonb_build_object('ok', true, 'already_revoked', false,
                            'granted_days', v_invoice.duration_days,
                            'plan_code', v_plan,
                            'paid_until', v_until, 'invoice_id', v_invoice.id);
end;
$$;

revoke all on function public.revoke_invoice_entitlement(uuid) from public, anon, authenticated;
grant execute on function public.revoke_invoice_entitlement(uuid) to service_role;

/* ─────────────────────  Переходы состояний Uzum  ─────────────────────
 *
 * ВСЁ ДЕЛАЕТСЯ ЗДЕСЬ, А НЕ В EDGE FUNCTION. Между двумя запросами из функции может оборваться
 * связь, истечь время выполнения, приехать второй запрос того же банка. Проверка состояния,
 * перевод состояния и начисление обязаны быть одной транзакцией — иначе появляется окно, в
 * котором транзакция уже CONFIRMED, а права не выданы (или наоборот).
 *
 * Каждая функция возвращает jsonb: { ok, error_code, ... }. error_code — строка протокола Uzum,
 * и решение о ней принимается ТАМ, ГДЕ ВИДНО СОСТОЯНИЕ, а не в HTTP-слое по домыслу.
 */

/* Найти счёт по order_id. Номер или uuid — та же пара форм, что у invoiceRefFrom для Click. */
create or replace function public.uzum_find_invoice(p_order_id text)
returns public.billing_invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
  v_text    text := pg_catalog.btrim(pg_catalog.coalesce(p_order_id, ''));
begin
  if v_text ~ '^[0-9]{1,18}$' then
    select * into v_invoice from public.billing_invoices where invoice_no = v_text::bigint;
  /*
   * UUID РАЗБИРАЕТСЯ ПО ТОЧНОЙ ФОРМЕ, а не «36 знаков из цифр, букв a-f и дефисов».
   *
   * Свободная форма пропускала строку из тридцати шести дефисов: она проходит проверку, а дальше
   * cast к uuid бросает исключение — и банк получает 99999 «внутренняя ошибка» там, где ответ
   * должен быть «такого счёта нет».
   */
  elsif v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select * into v_invoice from public.billing_invoices where id = v_text::uuid;
  end if;
  return v_invoice;
end;
$$;

revoke all on function public.uzum_find_invoice(text) from public, anon, authenticated;
grant execute on function public.uzum_find_invoice(text) to service_role;

/*
 * /check — можно ли платить по этому order_id.
 *
 * Сумму банк на этом шаге не присылает, поэтому проверяется всё остальное: счёт существует, не
 * оплачен, не отменён, не просрочен. Отвечать «ок» на закрытый счёт значит позволить банку
 * начать оплату, которую мы обязаны будем отклонить на /create, — покупатель увидит отказ уже
 * после того, как ввёл карту.
 */
create or replace function public.uzum_check_order(p_order_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice public.billing_invoices%rowtype;
begin
  v_invoice := public.uzum_find_invoice(p_order_id);
  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10007');
  end if;
  if v_invoice.entitlement_applied_at is not null or v_invoice.status = 'paid' then
    return jsonb_build_object('ok', false, 'error_code', '10008');
  end if;
  if v_invoice.status in ('cancelled', 'expired') then
    return jsonb_build_object('ok', false, 'error_code', '10009');
  end if;
  if v_invoice.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error_code', '10009');
  end if;
  return jsonb_build_object('ok', true, 'invoice_id', v_invoice.id,
                            'account_id', v_invoice.account_id,
                            'amount', v_invoice.amount_tiyin,
                            'plan_code', v_invoice.plan_code);
end;
$$;

revoke all on function public.uzum_check_order(text) from public, anon, authenticated;
grant execute on function public.uzum_check_order(text) to service_role;

/*
 * /create — завести транзакцию под счёт.
 *
 * СУММА СВЕРЯЕТСЯ ЗДЕСЬ, и это главное, чего не было в задании. Без сверки достаточно создать
 * транзакцию на один тийин и подтвердить её, чтобы получить полный тариф: /confirm сам суммы не
 * знает, он лишь доводит до конца то, что создано. Код 10011 — штатный «неверная сумма».
 */
create or replace function public.uzum_create_transaction(
  p_trans_id   text,
  p_order_id   text,
  p_amount     bigint,
  p_service_id bigint,
  p_trans_time bigint,
  p_payment_source text,
  p_phone      text,
  p_payload    jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invoice   public.billing_invoices%rowtype;
  v_existing  public.uzum_transactions%rowtype;
  v_constraint text;
begin
  -- Повтор с тем же transId — раньше всего остального: банк ретраит, и ответ обязан быть тем же,
  -- каким бы ни стало состояние счёта с прошлого раза.
  select * into v_existing from public.uzum_transactions where trans_id = p_trans_id;
  if v_existing.id is not null then
    return jsonb_build_object('ok', false, 'error_code', '10010');
  end if;

  v_invoice := public.uzum_find_invoice(p_order_id);
  if v_invoice.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10007');
  end if;

  /*
   * СЧЁТ БЛОКИРУЕТСЯ ДО ПРОВЕРОК, А НЕ ПОСЛЕ.
   *
   * uzum_find_invoice читает без блокировки. Между этим чтением и вставкой другой провайдер —
   * Payme или Click — успевает закрыть тот же счёт: наша транзакция всё равно станет CREATED, а
   * следующий /confirm упрётся в уже начисленный счёт и навсегда останется в CREATED. Повторное
   * чтение под блокировкой закрывает это окно.
   */
  select * into v_invoice from public.billing_invoices where id = v_invoice.id for update;

  if v_invoice.entitlement_applied_at is not null or v_invoice.status = 'paid' then
    return jsonb_build_object('ok', false, 'error_code', '10008');
  end if;
  if v_invoice.status in ('cancelled', 'expired') or v_invoice.expires_at <= pg_catalog.now() then
    return jsonb_build_object('ok', false, 'error_code', '10009');
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> v_invoice.amount_tiyin then
    return jsonb_build_object('ok', false, 'error_code', '10011');
  end if;

  begin
    insert into public.uzum_transactions
      (trans_id, order_id, invoice_id, account_id, amount, status, service_id,
       trans_time, payment_source, phone, raw_payload)
    values
      (p_trans_id, p_order_id, v_invoice.id, v_invoice.account_id, p_amount, 'CREATED', p_service_id,
       p_trans_time, p_payment_source, p_phone, p_payload);

    -- Общий реестр пополняется ТОЙ ЖЕ транзакцией. state=1 — «создана», как у Payme и Click.
    insert into public.billing_transactions
      (provider, provider_transaction_id, invoice_id, account_id, amount_tiyin, state)
    values ('uzum', p_trans_id, v_invoice.id, v_invoice.account_id, p_amount, 1);
  exception
    /*
     * Гонка двух /create. Различается по ИМЕНИ ограничения, а не по повторному чтению.
     *
     * Первая версия ловила любой unique_violation и объявляла его «по брони уже есть транзакция».
     * Так под 10008 пряталось бы что угодно: сбитая последовательность, будущий индекс, чужое
     * ограничение. Банк получал бы осмысленный код на нашу поломку, и искать её стали бы у него.
     */
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'uzum_transactions_trans_id_key' then
        return jsonb_build_object('ok', false, 'error_code', '10010');
      elsif v_constraint = 'uzum_transactions_live_invoice_idx'
         or v_constraint = 'billing_transactions_provider_provider_transaction_id_key' then
        return jsonb_build_object('ok', false, 'error_code', '10008');
      end if;
      -- Незнакомое ограничение — наша поломка, и говорится об этом прямо.
      return jsonb_build_object('ok', false, 'error_code', '99999', 'reason', v_constraint);
  end;

  return jsonb_build_object('ok', true, 'invoice_id', v_invoice.id, 'amount', p_amount);
end;
$$;

revoke all on function public.uzum_create_transaction(text, text, bigint, bigint, bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.uzum_create_transaction(text, text, bigint, bigint, bigint, text, text, jsonb) to service_role;

/*
 * /confirm — деньги списаны, выдать права.
 *
 * Блокировка строки транзакции ПЕРВОЙ: одновременные /confirm и /reverse обязаны выстроиться в
 * очередь, иначе оба прочитают CREATED и оба выполнятся — деньги вернутся покупателю, а тариф
 * останется выданным.
 */
create or replace function public.uzum_confirm_transaction(
  p_trans_id text,
  p_confirm_time bigint,
  p_payment_source text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx      public.uzum_transactions%rowtype;
  v_invoice public.billing_invoices%rowtype;
  v_applied jsonb;
begin
  select * into v_tx from public.uzum_transactions where trans_id = p_trans_id for update;
  if v_tx.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10014');
  end if;
  if v_tx.status = 'CONFIRMED' then
    return jsonb_build_object('ok', false, 'error_code', '10016');
  end if;
  if v_tx.status in ('REVERSED', 'FAILED') then
    return jsonb_build_object('ok', false, 'error_code', '10015');
  end if;

  /*
   * СРОК СЧЁТА ПРОВЕРЯЕТСЯ ЗАНОВО, И ЭТО НЕ ПОВТОР ПРОВЕРКИ ИЗ /create.
   *
   * У транзакции нет собственного времени жизни: она висит CREATED, пока банк не придёт. Срок ей
   * задаёт счёт — а apply_invoice_entitlement на expires_at не смотрит вовсе, ей достаточно, что
   * начисления ещё не было. Без этой проверки транзакцию, созданную полгода назад по счёту,
   * который давно протух, можно подтвердить сегодня и получить тариф по прошлогодней цене.
   *
   * Просроченная переводится в FAILED здесь же: оставить её CREATED значит позволить банку
   * повторять попытку вечно.
   */
  select * into v_invoice from public.billing_invoices where id = v_tx.invoice_id for update;
  if v_invoice.id is null
     or v_invoice.status in ('cancelled', 'expired')
     or (v_invoice.entitlement_applied_at is null and v_invoice.expires_at <= pg_catalog.now())
  then
    update public.uzum_transactions
       set status = 'FAILED', updated_at = pg_catalog.now()
     where id = v_tx.id;
    update public.billing_transactions
       set state = -1, cancelled_at = pg_catalog.now()
     where provider = 'uzum' and provider_transaction_id = p_trans_id;
    return jsonb_build_object('ok', false, 'error_code', '10015', 'reason', 'invoice_expired');
  end if;

  v_applied := public.apply_invoice_entitlement(v_tx.invoice_id);
  if not (v_applied->>'ok')::boolean then
    -- Счёт закрылся между /create и /confirm. Права не выданы, и транзакция обязана это
    -- отразить: оставить её CREATED значит позволить банку повторять попытку вечно.
    update public.uzum_transactions
       set status = 'FAILED', updated_at = pg_catalog.now()
     where id = v_tx.id;
    update public.billing_transactions
       set state = -1, cancelled_at = pg_catalog.now()
     where provider = 'uzum' and provider_transaction_id = p_trans_id;
    return jsonb_build_object('ok', false, 'error_code', '10015', 'reason', v_applied->>'reason');
  end if;

  /*
   * Источник платежа и телефон дописываются ЗДЕСЬ.
   *
   * Банк присылает их на подтверждении, а не на создании: на /create он ещё не знает, чем
   * заплатят. Сохраняя только create-значения, мы получили бы две колонки, всегда пустые, — и
   * узнали бы об этом при первом же разборе спора, когда понадобится ответить «чем платили».
   *
   * coalesce, а не перезапись: повторный запрос без этих полей не должен стирать уже записанные.
   */
  update public.uzum_transactions
     set status = 'CONFIRMED',
         confirm_time = p_confirm_time,
         payment_source = coalesce(p_payment_source, payment_source),
         phone = coalesce(p_phone, phone),
         updated_at = pg_catalog.now()
   where id = v_tx.id;
  update public.billing_transactions
     set state = 2, performed_at = pg_catalog.now()
   where provider = 'uzum' and provider_transaction_id = p_trans_id;

  return jsonb_build_object('ok', true, 'amount', v_tx.amount, 'order_id', v_tx.order_id,
                            'paid_until', v_applied->>'paid_until');
end;
$$;

revoke all on function public.uzum_confirm_transaction(text, bigint, text, text) from public, anon, authenticated;
grant execute on function public.uzum_confirm_transaction(text, bigint, text, text) to service_role;

/*
 * /reverse — деньги возвращены покупателю.
 *
 * Отменяется и ПОДТВЕРЖДЁННАЯ транзакция: банк это умеет, и оставить в такой момент подписку
 * продлённой значит сделать возврат способом получить тариф даром.
 */
create or replace function public.uzum_reverse_transaction(p_trans_id text, p_reverse_time bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tx      public.uzum_transactions%rowtype;
  v_revoked jsonb := '{}'::jsonb;
begin
  select * into v_tx from public.uzum_transactions where trans_id = p_trans_id for update;
  if v_tx.id is null then
    return jsonb_build_object('ok', false, 'error_code', '10014');
  end if;
  if v_tx.status = 'REVERSED' then
    return jsonb_build_object('ok', false, 'error_code', '10018');
  end if;
  -- Провалившуюся отменять нечего: денег по ней не было. Штатный код именно для этого — 10017.
  if v_tx.status = 'FAILED' then
    return jsonb_build_object('ok', false, 'error_code', '10017');
  end if;

  if v_tx.status = 'CONFIRMED' then
    v_revoked := public.revoke_invoice_entitlement(v_tx.invoice_id);
    if not (v_revoked->>'ok')::boolean then
      return jsonb_build_object('ok', false, 'error_code', '99999', 'reason', v_revoked->>'reason');
    end if;
  else
    -- Не подтверждённую отменяем вместе со счётом: покупатель ушёл, счёт больше не ждёт оплаты.
    update public.billing_invoices
       set status = 'cancelled'
     where id = v_tx.invoice_id and entitlement_applied_at is null;
  end if;

  update public.billing_transactions
     set state = case when v_tx.status = 'CONFIRMED' then -2 else -1 end,
         cancelled_at = pg_catalog.now()
   where provider = 'uzum' and provider_transaction_id = p_trans_id;

  update public.uzum_transactions
     set status = 'REVERSED', reverse_time = p_reverse_time, updated_at = pg_catalog.now()
   where id = v_tx.id;

  return jsonb_build_object('ok', true, 'amount', v_tx.amount, 'order_id', v_tx.order_id,
                            'reverted_days', v_revoked->>'granted_days');
end;
$$;

revoke all on function public.uzum_reverse_transaction(text, bigint) from public, anon, authenticated;
grant execute on function public.uzum_reverse_transaction(text, bigint) to service_role;

-- ─── 20260824120000_durable_runtime_phase1.sql ───────────────────────────────────────────────
-- ADR 001 / Durable Operations Runtime v1 / Phase 1
-- Closed schema, tables, constraints, indexes, retention metadata and kill switch.
-- No consumer grants and no production traffic are enabled by this migration.

create schema runtime;

revoke all on schema runtime from public, anon, authenticated;
alter default privileges in schema runtime revoke all on tables from public, anon, authenticated;
alter default privileges in schema runtime revoke all on sequences from public, anon, authenticated;
alter default privileges in schema runtime revoke all on functions from public, anon, authenticated;

create function runtime.prevent_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only', tg_table_schema, tg_table_name);
end;
$$;

-- The state pair is a database invariant, not only an RPC convention.
create table runtime.allowed_workflow_transitions (
  from_state text not null,
  to_state text not null,
  primary key (from_state, to_state),
  constraint allowed_transition_from_state_check check (from_state in (
    'received', 'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
    'waiting_for_action', 'retry_scheduled'
  )),
  constraint allowed_transition_to_state_check check (to_state in (
    'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
    'waiting_for_action', 'retry_scheduled', 'completed', 'failed', 'denied',
    'dead_letter', 'cancelled'
  )),
  constraint allowed_transition_not_identity_check check (from_state <> to_state)
);

insert into runtime.allowed_workflow_transitions (from_state, to_state) values
  ('received', 'queued'),
  ('received', 'waiting_for_policy'),
  ('received', 'retry_scheduled'),
  ('received', 'failed'),
  ('received', 'cancelled'),
  ('queued', 'running'),
  ('queued', 'cancelled'),
  ('queued', 'dead_letter'),
  ('running', 'queued'),
  ('running', 'waiting_for_policy'),
  ('running', 'retry_scheduled'),
  ('running', 'completed'),
  ('running', 'failed'),
  ('running', 'dead_letter'),
  ('running', 'cancelled'),
  ('waiting_for_policy', 'waiting_for_action'),
  ('waiting_for_policy', 'waiting_for_approval'),
  ('waiting_for_policy', 'denied'),
  ('waiting_for_policy', 'retry_scheduled'),
  ('waiting_for_policy', 'failed'),
  ('waiting_for_policy', 'cancelled'),
  ('waiting_for_approval', 'waiting_for_action'),
  ('waiting_for_approval', 'denied'),
  ('waiting_for_approval', 'waiting_for_policy'),
  ('waiting_for_approval', 'cancelled'),
  ('waiting_for_action', 'queued'),
  ('waiting_for_action', 'completed'),
  ('waiting_for_action', 'retry_scheduled'),
  ('waiting_for_action', 'failed'),
  ('waiting_for_action', 'dead_letter'),
  ('waiting_for_action', 'cancelled'),
  ('retry_scheduled', 'queued'),
  ('retry_scheduled', 'dead_letter'),
  ('retry_scheduled', 'cancelled');

create trigger allowed_workflow_transitions_immutable
before update or delete on runtime.allowed_workflow_transitions
for each row execute function runtime.prevent_mutation();

-- Accepted, normalized input is immutable. Processing state belongs to workflow_runs.
create table runtime.inbox_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  provider text not null,
  event_type text not null,
  external_event_id text not null,
  external_event_id_hash text not null,
  identity_version text not null,
  correlation_id uuid not null,
  causation_id uuid,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  contract_version text not null,
  normalization_result text not null,
  payload jsonb not null,
  payload_hash text not null,
  hash_algorithm text not null default 'sha256',
  evidence_ref text,
  constraint inbox_events_account_id_id_key unique (account_id, id),
  constraint inbox_events_identity_key unique (
    account_id, provider, identity_version, external_event_id_hash
  ),
  constraint inbox_events_provider_check check (
    char_length(provider) between 1 and 64 and provider ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint inbox_events_event_type_check check (char_length(event_type) between 1 and 96),
  constraint inbox_events_external_id_check check (char_length(external_event_id) between 1 and 2048),
  constraint inbox_events_identity_version_check check (char_length(identity_version) between 1 and 32),
  constraint inbox_events_external_hash_check check (external_event_id_hash ~ '^[0-9a-f]{64}$'),
  constraint inbox_events_contract_version_check check (char_length(contract_version) between 1 and 64),
  constraint inbox_events_normalization_result_check check (
    normalization_result in ('accepted', 'accepted_with_redaction')
  ),
  constraint inbox_events_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint inbox_events_payload_size_check check (octet_length(payload::text) <= 65536),
  constraint inbox_events_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint inbox_events_hash_algorithm_check check (hash_algorithm = 'sha256'),
  constraint inbox_events_evidence_ref_check check (
    evidence_ref is null or char_length(evidence_ref) between 1 and 1024
  )
);

create trigger inbox_events_immutable
before update or delete on runtime.inbox_events
for each row execute function runtime.prevent_mutation();

create table runtime.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  inbox_event_id uuid not null,
  workflow_type text not null,
  workflow_version text not null,
  execution_mode text not null,
  current_state text not null default 'received',
  correlation_id uuid not null,
  causation_id uuid,
  lease_holder text,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  last_error_code text,
  sanitized_error_message text,
  error_evidence_ref text,
  terminal_reason_code text,
  terminal_at timestamptz,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint workflow_runs_account_id_id_key unique (account_id, id),
  constraint workflow_runs_event_identity_key unique (
    account_id, inbox_event_id, workflow_type, workflow_version, execution_mode
  ),
  constraint workflow_runs_inbox_fkey foreign key (account_id, inbox_event_id)
    references runtime.inbox_events(account_id, id) on delete restrict,
  constraint workflow_runs_causation_fkey foreign key (account_id, causation_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint workflow_runs_type_check check (char_length(workflow_type) between 1 and 128),
  constraint workflow_runs_version_check check (char_length(workflow_version) between 1 and 64),
  constraint workflow_runs_execution_mode_check check (execution_mode in ('shadow', 'live')),
  constraint workflow_runs_state_check check (current_state in (
    'received', 'queued', 'running', 'waiting_for_policy', 'waiting_for_approval',
    'waiting_for_action', 'retry_scheduled', 'completed', 'failed', 'denied',
    'dead_letter', 'cancelled'
  )),
  constraint workflow_runs_lease_epoch_check check (lease_epoch >= 0),
  constraint workflow_runs_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 100 and attempt_count <= max_attempts
  ),
  constraint workflow_runs_retry_time_check check (
    (current_state = 'retry_scheduled' and next_attempt_at is not null)
    or (current_state <> 'retry_scheduled' and next_attempt_at is null)
  ),
  constraint workflow_runs_lease_integrity_check check (
    (current_state = 'running'
      and lease_holder is not null and lease_until is not null and claim_token is not null)
    or (current_state <> 'running'
      and lease_holder is null and lease_until is null and claim_token is null)
  ),
  constraint workflow_runs_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint workflow_runs_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint workflow_runs_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 512
  ),
  constraint workflow_runs_error_evidence_ref_check check (
    error_evidence_ref is null or char_length(error_evidence_ref) between 1 and 1024
  ),
  constraint workflow_runs_terminal_integrity_check check (
    (current_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled')
      and terminal_at is not null
      and (current_state = 'completed' or terminal_reason_code is not null))
    or (current_state not in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled')
      and terminal_at is null and terminal_reason_code is null)
  ),
  constraint workflow_runs_terminal_reason_check check (
    terminal_reason_code is null or terminal_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint workflow_runs_context_object_check check (jsonb_typeof(context) = 'object'),
  constraint workflow_runs_context_size_check check (octet_length(context::text) <= 65536)
);

create table runtime.workflow_transitions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  transition_seq bigint not null,
  from_state text not null,
  to_state text not null,
  transition_type text not null,
  actor_type text not null,
  actor_id text not null,
  correlation_id uuid not null,
  causation_id uuid,
  workflow_version text not null,
  policy_version text,
  claim_token uuid,
  lease_epoch bigint not null,
  transition_payload jsonb,
  payload_hash text,
  evidence_ref text,
  evidence_hash text,
  created_at timestamptz not null default clock_timestamp(),
  constraint workflow_transitions_account_id_id_key unique (account_id, id),
  constraint workflow_transitions_workflow_id_id_key unique (account_id, workflow_id, id),
  constraint workflow_transitions_seq_key unique (account_id, workflow_id, transition_seq),
  constraint workflow_transitions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint workflow_transitions_pair_fkey foreign key (from_state, to_state)
    references runtime.allowed_workflow_transitions(from_state, to_state) on delete restrict,
  constraint workflow_transitions_seq_check check (transition_seq > 0),
  constraint workflow_transitions_type_check check (transition_type in (
    'ingested', 'classified', 'planned', 'policy_requested', 'policy_decided',
    'approval_requested', 'approval_resolved', 'action_enqueued', 'action_completed',
    'checkpoint_saved', 'retry_scheduled', 'completed', 'failed', 'denied',
    'cancelled', 'dead_letter', 'recovered'
  )),
  constraint workflow_transitions_actor_type_check check (
    actor_type in ('system', 'worker', 'user', 'admin', 'maintenance')
  ),
  constraint workflow_transitions_actor_id_check check (char_length(actor_id) between 1 and 160),
  constraint workflow_transitions_lease_epoch_check check (lease_epoch >= 0),
  constraint workflow_transitions_payload_object_check check (
    transition_payload is null or jsonb_typeof(transition_payload) = 'object'
  ),
  constraint workflow_transitions_payload_size_check check (
    transition_payload is null or octet_length(transition_payload::text) <= 16384
  ),
  constraint workflow_transitions_payload_hash_check check (
    payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint workflow_transitions_evidence_ref_check check (
    evidence_ref is null or char_length(evidence_ref) between 1 and 1024
  ),
  constraint workflow_transitions_evidence_hash_check check (
    evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'
  )
);

create trigger workflow_transitions_immutable
before update or delete on runtime.workflow_transitions
for each row execute function runtime.prevent_mutation();

create table runtime.policy_decisions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  transition_id uuid not null,
  ruleset_id text not null,
  policy_version text not null,
  decision text not null,
  reasons jsonb not null default '[]'::jsonb,
  input_hash text not null,
  action_payload_hash text not null,
  canonicalization_version text not null,
  evidence_ref text,
  created_at timestamptz not null default clock_timestamp(),
  constraint policy_decisions_account_id_id_key unique (account_id, id),
  constraint policy_decisions_workflow_id_id_key unique (account_id, workflow_id, id),
  constraint policy_decisions_action_identity_key unique (
    account_id, workflow_id, id, policy_version, canonicalization_version, action_payload_hash
  ),
  constraint policy_decisions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint policy_decisions_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint policy_decisions_ruleset_check check (char_length(ruleset_id) between 1 and 128),
  constraint policy_decisions_version_check check (char_length(policy_version) between 1 and 64),
  constraint policy_decisions_decision_check check (
    decision in ('allow', 'deny', 'require_approval')
  ),
  constraint policy_decisions_reasons_array_check check (jsonb_typeof(reasons) = 'array'),
  constraint policy_decisions_reasons_size_check check (octet_length(reasons::text) <= 8192),
  constraint policy_decisions_input_hash_check check (input_hash ~ '^[0-9a-f]{64}$'),
  constraint policy_decisions_action_hash_check check (action_payload_hash ~ '^[0-9a-f]{64}$'),
  constraint policy_decisions_canonicalization_check check (
    char_length(canonicalization_version) between 1 and 32
  ),
  constraint policy_decisions_evidence_ref_check check (
    evidence_ref is null or char_length(evidence_ref) between 1 and 1024
  )
);

create trigger policy_decisions_immutable
before update or delete on runtime.policy_decisions
for each row execute function runtime.prevent_mutation();

create table runtime.outbox_actions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  transition_id uuid not null,
  policy_decision_id uuid not null,
  approval_request_id uuid,
  policy_version text not null,
  connector_id text not null,
  action_type text not null,
  execution_mode text not null,
  payload jsonb not null,
  action_payload_hash text not null,
  canonicalization_version text not null,
  idempotency_key text not null,
  idempotency_key_hash text not null,
  status text not null,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  completed_at timestamptz,
  provider_result_ref text,
  reconciliation_state text not null default 'not_required',
  last_error_code text,
  sanitized_error_message text,
  error_evidence_ref text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint outbox_actions_account_id_id_key unique (account_id, id),
  constraint outbox_actions_workflow_id_id_key unique (account_id, workflow_id, id),
  constraint outbox_actions_idempotency_key unique (
    account_id, connector_id, idempotency_key_hash
  ),
  constraint outbox_actions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint outbox_actions_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint outbox_actions_policy_fkey foreign key (
    account_id, workflow_id, policy_decision_id, policy_version,
    canonicalization_version, action_payload_hash
  ) references runtime.policy_decisions(
    account_id, workflow_id, id, policy_version, canonicalization_version, action_payload_hash
  ) on delete restrict,
  constraint outbox_actions_connector_check check (char_length(connector_id) between 1 and 160),
  constraint outbox_actions_action_type_check check (char_length(action_type) between 1 and 128),
  constraint outbox_actions_policy_version_check check (char_length(policy_version) between 1 and 64),
  constraint outbox_actions_mode_check check (execution_mode in ('shadow', 'live')),
  constraint outbox_actions_status_check check (status in (
    'pending', 'processing', 'retry_scheduled', 'completed', 'failed',
    'dead_letter', 'cancelled', 'simulated'
  )),
  constraint outbox_actions_shadow_invariants_check check (
    (execution_mode = 'shadow' and status = 'simulated')
    or (execution_mode = 'live' and status in (
      'pending', 'processing', 'retry_scheduled', 'completed', 'failed',
      'dead_letter', 'cancelled'
    ))
  ),
  constraint outbox_actions_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint outbox_actions_payload_size_check check (octet_length(payload::text) <= 16384),
  constraint outbox_actions_action_hash_check check (action_payload_hash ~ '^[0-9a-f]{64}$'),
  constraint outbox_actions_canonicalization_check check (
    char_length(canonicalization_version) between 1 and 64
  ),
  constraint outbox_actions_idempotency_value_check check (
    char_length(idempotency_key) between 1 and 2048
  ),
  constraint outbox_actions_idempotency_hash_check check (
    idempotency_key_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint outbox_actions_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 100 and attempt_count <= max_attempts
  ),
  constraint outbox_actions_retry_time_check check (
    (status = 'retry_scheduled' and next_attempt_at is not null)
    or (status <> 'retry_scheduled' and next_attempt_at is null)
  ),
  constraint outbox_actions_lease_integrity_check check (
    (status = 'processing' and claimed_at is not null
      and lease_until is not null and claim_token is not null)
    or (status <> 'processing' and lease_until is null and claim_token is null)
  ),
  constraint outbox_actions_lease_epoch_check check (lease_epoch >= 0),
  constraint outbox_actions_completion_check check (
    (status in ('completed', 'failed', 'dead_letter', 'cancelled', 'simulated')
      and completed_at is not null)
    or (status not in ('completed', 'failed', 'dead_letter', 'cancelled', 'simulated')
      and completed_at is null)
  ),
  constraint outbox_actions_reconciliation_check check (
    reconciliation_state in (
      'not_required', 'ambiguous', 'confirmed_effect', 'confirmed_no_effect'
    )
  ),
  constraint outbox_actions_ambiguous_check check (
    reconciliation_state <> 'ambiguous' or status = 'dead_letter'
  ),
  constraint outbox_actions_shadow_reconciliation_check check (
    execution_mode <> 'shadow' or reconciliation_state = 'not_required'
  ),
  constraint outbox_actions_result_ref_check check (
    provider_result_ref is null or char_length(provider_result_ref) between 1 and 1024
  ),
  constraint outbox_actions_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint outbox_actions_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 512
  ),
  constraint outbox_actions_error_evidence_ref_check check (
    error_evidence_ref is null or char_length(error_evidence_ref) between 1 and 1024
  )
);

-- Existing approvals remain valid. Runtime linkage is nullable for backwards compatibility.
alter table public.approval_requests
  add column if not exists workflow_id uuid,
  add column if not exists transition_id uuid,
  add column if not exists policy_decision_id uuid,
  add column if not exists outbox_action_id uuid,
  add column if not exists policy_version text,
  add column if not exists action_canonicalization_version text,
  add column if not exists action_payload_hash text;

alter table public.approval_requests
  add constraint approval_requests_account_id_id_key unique (account_id, id),
  add constraint approval_requests_runtime_workflow_id_id_key unique (account_id, workflow_id, id),
  add constraint approval_requests_runtime_workflow_fkey
    foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  add constraint approval_requests_runtime_transition_fkey
    foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  add constraint approval_requests_runtime_policy_fkey
    foreign key (
      account_id, workflow_id, policy_decision_id, policy_version,
      action_canonicalization_version, action_payload_hash
    ) references runtime.policy_decisions(
      account_id, workflow_id, id, policy_version, canonicalization_version, action_payload_hash
    ) on delete restrict,
  add constraint approval_requests_runtime_outbox_fkey
    foreign key (account_id, workflow_id, outbox_action_id)
    references runtime.outbox_actions(account_id, workflow_id, id) on delete restrict,
  add constraint approval_requests_runtime_shape_check check (
    (workflow_id is null and transition_id is null and policy_decision_id is null
      and outbox_action_id is null and policy_version is null
      and action_canonicalization_version is null and action_payload_hash is null)
    or (workflow_id is not null and transition_id is not null and policy_decision_id is not null
      and policy_version is not null and action_canonicalization_version is not null
      and action_payload_hash is not null and source = 'workflow')
  ),
  add constraint approval_requests_runtime_outbox_lifecycle_check check (
    workflow_id is null
    or (status = 'approved' and outbox_action_id is not null)
    or (status <> 'approved' and outbox_action_id is null)
  ),
  add constraint approval_requests_runtime_action_hash_check check (
    action_payload_hash is null or action_payload_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint approval_requests_runtime_canonicalization_check check (
    action_canonicalization_version is null
    or char_length(action_canonicalization_version) between 1 and 64
  );

alter table runtime.outbox_actions
  add constraint outbox_actions_approval_fkey
  foreign key (account_id, workflow_id, approval_request_id)
  references public.approval_requests(account_id, workflow_id, id) on delete restrict;

create table runtime.audit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  workflow_id uuid,
  transition_id uuid,
  policy_decision_id uuid,
  approval_request_id uuid,
  outbox_action_id uuid,
  parent_audit_event_id uuid,
  event_type text not null,
  actor_type text not null,
  actor_id text not null,
  correlation_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  payload_hash text,
  hash_algorithm text not null default 'sha256',
  runtime_contract_version text not null,
  workflow_version text,
  policy_version text,
  created_at timestamptz not null default clock_timestamp(),
  constraint audit_events_account_id_id_key unique (account_id, id),
  constraint audit_events_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint audit_events_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint audit_events_policy_fkey foreign key (account_id, workflow_id, policy_decision_id)
    references runtime.policy_decisions(account_id, workflow_id, id) on delete restrict,
  constraint audit_events_approval_fkey foreign key (account_id, approval_request_id)
    references public.approval_requests(account_id, id) on delete restrict,
  constraint audit_events_outbox_fkey foreign key (account_id, workflow_id, outbox_action_id)
    references runtime.outbox_actions(account_id, workflow_id, id) on delete restrict,
  constraint audit_events_parent_fkey foreign key (account_id, parent_audit_event_id)
    references runtime.audit_events(account_id, id) on delete restrict,
  constraint audit_events_event_type_check check (char_length(event_type) between 1 and 128),
  constraint audit_events_actor_type_check check (
    actor_type in ('system', 'worker', 'user', 'admin', 'maintenance')
  ),
  constraint audit_events_actor_id_check check (char_length(actor_id) between 1 and 160),
  constraint audit_events_details_object_check check (jsonb_typeof(details) = 'object'),
  constraint audit_events_details_size_check check (octet_length(details::text) <= 16384),
  constraint audit_events_payload_hash_check check (
    payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint audit_events_hash_algorithm_check check (hash_algorithm = 'sha256'),
  constraint audit_events_contract_version_check check (
    char_length(runtime_contract_version) between 1 and 64
  ),
  constraint audit_events_runtime_reference_shape_check check (
    (transition_id is null or workflow_id is not null)
    and (policy_decision_id is null or workflow_id is not null)
    and (outbox_action_id is null or workflow_id is not null)
  )
);

create trigger audit_events_immutable
before update or delete on runtime.audit_events
for each row execute function runtime.prevent_mutation();

create table runtime.dead_letters (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  source_kind text not null,
  workflow_id uuid,
  outbox_action_id uuid,
  inbox_event_id uuid,
  error_code text not null,
  sanitized_error_message text,
  error_evidence_ref text,
  payload_snapshot jsonb not null default '{}'::jsonb,
  attempt_history jsonb not null default '[]'::jsonb,
  resolved boolean not null default false,
  resolution_reason_code text,
  resolution_action text,
  resolved_by uuid references public.users(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint dead_letters_account_id_id_key unique (account_id, id),
  constraint dead_letters_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint dead_letters_outbox_fkey foreign key (account_id, outbox_action_id)
    references runtime.outbox_actions(account_id, id) on delete restrict,
  constraint dead_letters_inbox_fkey foreign key (account_id, inbox_event_id)
    references runtime.inbox_events(account_id, id) on delete restrict,
  constraint dead_letters_source_kind_check check (
    source_kind in ('workflow', 'outbox_action', 'inbox_event')
  ),
  constraint dead_letters_source_shape_check check (
    (source_kind = 'workflow' and workflow_id is not null
      and outbox_action_id is null and inbox_event_id is null)
    or (source_kind = 'outbox_action' and workflow_id is null
      and outbox_action_id is not null and inbox_event_id is null)
    or (source_kind = 'inbox_event' and workflow_id is null
      and outbox_action_id is null and inbox_event_id is not null)
  ),
  constraint dead_letters_error_code_check check (error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint dead_letters_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 512
  ),
  constraint dead_letters_error_evidence_ref_check check (
    error_evidence_ref is null or char_length(error_evidence_ref) between 1 and 1024
  ),
  constraint dead_letters_payload_object_check check (jsonb_typeof(payload_snapshot) = 'object'),
  constraint dead_letters_payload_size_check check (octet_length(payload_snapshot::text) <= 32768),
  constraint dead_letters_attempt_history_check check (jsonb_typeof(attempt_history) = 'array'),
  constraint dead_letters_attempt_history_size_check check (octet_length(attempt_history::text) <= 32768),
  constraint dead_letters_resolution_integrity_check check (
    (not resolved and resolution_reason_code is null and resolution_action is null
      and resolved_by is null and resolved_at is null)
    or (resolved and resolution_reason_code is not null and resolution_action is not null
      and resolved_by is not null and resolved_at is not null)
  ),
  constraint dead_letters_resolution_reason_check check (
    resolution_reason_code is null or resolution_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint dead_letters_resolution_action_check check (
    resolution_action is null or char_length(resolution_action) between 1 and 512
  )
);

create table runtime.connector_health (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  connector_id text not null,
  operation text not null,
  state text not null default 'closed',
  consecutive_failures integer not null default 0,
  failure_threshold integer not null default 5,
  cooldown_seconds integer not null default 60,
  failure_window_started_at timestamptz,
  opened_until timestamptz,
  half_open_probe_token uuid,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  tripped_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint connector_health_account_id_id_key unique (account_id, id),
  constraint connector_health_operation_key unique (account_id, connector_id, operation),
  constraint connector_health_connector_check check (char_length(connector_id) between 1 and 160),
  constraint connector_health_operation_check check (char_length(operation) between 1 and 128),
  constraint connector_health_state_check check (state in ('closed', 'open', 'half_open')),
  constraint connector_health_failures_check check (consecutive_failures >= 0),
  constraint connector_health_threshold_check check (failure_threshold between 1 and 1000),
  constraint connector_health_cooldown_check check (cooldown_seconds between 1 and 86400),
  constraint connector_health_state_integrity_check check (
    (state = 'closed' and opened_until is null and half_open_probe_token is null)
    or (state = 'open' and opened_until is not null and half_open_probe_token is null)
    or (state = 'half_open' and half_open_probe_token is not null)
  )
);

create table runtime.feedback_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  workflow_id uuid not null,
  transition_id uuid not null,
  feedback_type text not null,
  reason_code text not null,
  original_action_snapshot jsonb not null,
  corrected_action_snapshot jsonb not null,
  created_by uuid not null references public.users(id) on delete restrict,
  eval_consent boolean not null default false,
  pii_redacted boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint feedback_events_account_id_id_key unique (account_id, id),
  constraint feedback_events_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint feedback_events_transition_fkey foreign key (account_id, workflow_id, transition_id)
    references runtime.workflow_transitions(account_id, workflow_id, id) on delete restrict,
  constraint feedback_events_type_check check (char_length(feedback_type) between 1 and 96),
  constraint feedback_events_reason_code_check check (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint feedback_events_original_object_check check (
    jsonb_typeof(original_action_snapshot) = 'object'
  ),
  constraint feedback_events_corrected_object_check check (
    jsonb_typeof(corrected_action_snapshot) = 'object'
  ),
  constraint feedback_events_snapshot_size_check check (
    octet_length(original_action_snapshot::text) <= 16384
    and octet_length(corrected_action_snapshot::text) <= 16384
  )
);

create trigger feedback_events_immutable
before update or delete on runtime.feedback_events
for each row execute function runtime.prevent_mutation();

-- Absence of a row means pending review. A review is itself immutable evidence.
create table runtime.feedback_reviews (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  feedback_event_id uuid not null,
  review_status text not null,
  review_reason_code text not null,
  reviewed_by uuid not null references public.users(id) on delete restrict,
  reviewed_at timestamptz not null default clock_timestamp(),
  constraint feedback_reviews_account_id_id_key unique (account_id, id),
  constraint feedback_reviews_event_key unique (account_id, feedback_event_id),
  constraint feedback_reviews_event_fkey foreign key (account_id, feedback_event_id)
    references runtime.feedback_events(account_id, id) on delete restrict,
  constraint feedback_reviews_status_check check (review_status in ('accepted', 'rejected')),
  constraint feedback_reviews_reason_code_check check (
    review_reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create trigger feedback_reviews_immutable
before update or delete on runtime.feedback_reviews
for each row execute function runtime.prevent_mutation();

-- Singleton control row. Phase 2 claim RPCs must lock/read it before selecting work.
create table runtime.system_controls (
  singleton boolean primary key default true,
  kill_switch_active boolean not null default false,
  claims_paused boolean not null default false,
  ingestion_paused boolean not null default false,
  reason_code text,
  activated_by text,
  activated_at timestamptz,
  control_epoch bigint not null default 0,
  updated_at timestamptz not null default clock_timestamp(),
  constraint system_controls_singleton_check check (singleton),
  constraint system_controls_epoch_check check (control_epoch >= 0),
  constraint system_controls_kill_switch_check check (
    not kill_switch_active or claims_paused
  ),
  constraint system_controls_activation_check check (
    (not kill_switch_active and not claims_paused and not ingestion_paused
      and reason_code is null and activated_by is null and activated_at is null)
    or ((kill_switch_active or claims_paused or ingestion_paused) and reason_code is not null
      and activated_by is not null and activated_at is not null)
  ),
  constraint system_controls_reason_check check (
    reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint system_controls_actor_check check (
    activated_by is null or char_length(activated_by) between 1 and 160
  )
);

insert into runtime.system_controls (singleton) values (true);

-- Retention is archive-first. Phase 1 never deletes workflow/audit history.
create table runtime.retention_policies (
  data_class text primary key,
  hot_retention interval,
  cold_archive_required boolean not null,
  deletion_allowed boolean not null,
  partition_strategy text not null,
  partition_review_threshold_rows bigint,
  updated_at timestamptz not null default clock_timestamp(),
  constraint retention_policies_data_class_check check (data_class in (
    'inbox_events', 'workflow_runs', 'workflow_transitions', 'audit_events', 'dead_letters'
  )),
  constraint retention_policies_hot_retention_check check (
    hot_retention is null or hot_retention >= interval '30 days'
  ),
  constraint retention_policies_partition_strategy_check check (
    partition_strategy in ('none', 'review_monthly_range_at_threshold')
  ),
  constraint retention_policies_partition_threshold_check check (
    (partition_strategy = 'none' and partition_review_threshold_rows is null)
    or (partition_strategy = 'review_monthly_range_at_threshold'
      and partition_review_threshold_rows >= 1000000)
  ),
  constraint retention_policies_archive_before_delete_check check (
    not deletion_allowed or cold_archive_required
  )
);

insert into runtime.retention_policies (
  data_class, hot_retention, cold_archive_required, deletion_allowed,
  partition_strategy, partition_review_threshold_rows
) values
  ('inbox_events', interval '30 days', true, false, 'review_monthly_range_at_threshold', 1000000),
  ('workflow_runs', interval '30 days', true, false, 'none', null),
  ('workflow_transitions', interval '30 days', true, false, 'review_monthly_range_at_threshold', 1000000),
  ('audit_events', null, true, false, 'review_monthly_range_at_threshold', 1000000),
  ('dead_letters', null, true, false, 'none', null);

create table runtime.archive_manifests (
  id uuid primary key default gen_random_uuid(),
  cutoff_at timestamptz not null,
  status text not null default 'prepared',
  requested_by text not null,
  cold_object_ref text,
  cold_object_hash text,
  exported_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint archive_manifests_status_check check (
    status in ('prepared', 'exported', 'verified', 'cancelled')
  ),
  constraint archive_manifests_requested_by_check check (
    char_length(requested_by) between 1 and 160
  ),
  constraint archive_manifests_object_ref_check check (
    cold_object_ref is null or char_length(cold_object_ref) between 1 and 1024
  ),
  constraint archive_manifests_object_hash_check check (
    cold_object_hash is null or cold_object_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint archive_manifests_export_integrity_check check (
    (status = 'prepared' and cold_object_ref is null and cold_object_hash is null
      and exported_at is null and verified_at is null)
    or (status = 'cancelled' and verified_at is null)
    or (status = 'exported' and cold_object_ref is not null and cold_object_hash is not null
      and exported_at is not null and verified_at is null)
    or (status = 'verified' and cold_object_ref is not null and cold_object_hash is not null
      and exported_at is not null and verified_at is not null)
  )
);

create table runtime.archive_manifest_items (
  manifest_id uuid not null references runtime.archive_manifests(id) on delete restrict,
  account_id uuid not null,
  workflow_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (manifest_id, account_id, workflow_id),
  constraint archive_manifest_items_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict
);

create trigger archive_manifest_items_immutable
before update or delete on runtime.archive_manifest_items
for each row execute function runtime.prevent_mutation();

-- Produces an auditable archive candidate set. It intentionally performs no DELETE.
create function runtime.prepare_archive_manifest(
  p_older_than interval,
  p_requested_by text,
  p_limit integer default 10000
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_manifest_id uuid := gen_random_uuid();
begin
  if p_older_than < interval '30 days' or p_older_than > interval '10 years' then
    raise exception using errcode = '22023', message = 'invalid retention window';
  end if;
  if p_limit < 1 or p_limit > 100000 then
    raise exception using errcode = '22023', message = 'invalid archive batch size';
  end if;
  if p_requested_by is null or char_length(p_requested_by) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid archive actor';
  end if;

  insert into runtime.archive_manifests (id, cutoff_at, requested_by)
  values (v_manifest_id, clock_timestamp() - p_older_than, p_requested_by);

  insert into runtime.archive_manifest_items (manifest_id, account_id, workflow_id)
  select v_manifest_id, candidate.account_id, candidate.id
  from runtime.workflow_runs as candidate
  where candidate.current_state in ('completed', 'cancelled')
    and candidate.terminal_at < clock_timestamp() - p_older_than
    and not exists (
      select 1
      from runtime.archive_manifest_items as existing
      join runtime.archive_manifests as manifest on manifest.id = existing.manifest_id
      where existing.account_id = candidate.account_id
        and existing.workflow_id = candidate.id
        and manifest.status <> 'cancelled'
    )
  order by candidate.terminal_at, candidate.id
  limit p_limit;

  return v_manifest_id;
end;
$$;

create index workflow_runs_ready_idx
  on runtime.workflow_runs (execution_mode, created_at, id)
  where current_state = 'queued';

create index workflow_runs_retry_idx
  on runtime.workflow_runs (execution_mode, next_attempt_at, id)
  where current_state = 'retry_scheduled';

create index workflow_runs_running_lease_idx
  on runtime.workflow_runs (lease_until, id)
  where current_state = 'running';

create index workflow_runs_correlation_idx
  on runtime.workflow_runs (account_id, correlation_id, created_at desc);

create index outbox_actions_pending_idx
  on runtime.outbox_actions (connector_id, created_at, id)
  where execution_mode = 'live' and status = 'pending';

create index outbox_actions_retry_idx
  on runtime.outbox_actions (connector_id, next_attempt_at, id)
  where execution_mode = 'live' and status = 'retry_scheduled';

create index outbox_actions_processing_lease_idx
  on runtime.outbox_actions (lease_until, id)
  where execution_mode = 'live' and status = 'processing';

create index audit_events_workflow_time_idx
  on runtime.audit_events (account_id, workflow_id, created_at, id);

create index dead_letters_open_idx
  on runtime.dead_letters (account_id, created_at, id)
  where not resolved;

revoke all on all tables in schema runtime from public, anon, authenticated;
revoke all on all sequences in schema runtime from public, anon, authenticated;
revoke all on all functions in schema runtime from public, anon, authenticated;

comment on schema runtime is
  'Private Durable Operations Runtime. Access is only through allowlisted Phase 2 RPC wrappers.';
comment on function runtime.prepare_archive_manifest(interval, text, integer) is
  'Prepares an archive manifest only. Physical deletion requires verified cold storage and a separate audited maintenance ADR.';

-- ─── 20260824140000_durable_runtime_phase2_rpc.sql ───────────────────────────────────────────
-- ADR 001 / Durable Operations Runtime v1 / Phase 2
-- Service-role-only public RPC wrappers for ingestion, workflow leasing, policy decisions and
-- outbox execution. The runtime schema remains private; callers never receive table privileges.

create function runtime.sha256_text(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

create function runtime.sha256_jsonb(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select runtime.sha256_text(p_value::text)
$$;

revoke all on function runtime.sha256_text(text) from public, anon, authenticated;
revoke all on function runtime.sha256_jsonb(jsonb) from public, anon, authenticated;

create function public.runtime_ingest_event(
  p_account_id uuid,
  p_provider text,
  p_external_event_id text,
  p_payload jsonb,
  p_execution_mode text,
  p_correlation_id uuid,
  p_event_type text default 'unknown',
  p_occurred_at timestamptz default clock_timestamp(),
  p_contract_version text default 'runtime-ingest-v1',
  p_identity_version text default 'v1',
  p_workflow_type text default null,
  p_workflow_version text default 'v1',
  p_actor_id text default 'runtime-ingest'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_inbox_id uuid;
  v_workflow_id uuid;
  v_transition_id uuid;
  v_external_hash text;
  v_payload_hash text;
  v_workflow_type text;
  v_created boolean := false;
begin
  if p_account_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'missing runtime identity';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'payload must be a JSON object';
  end if;
  if p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'invalid execution mode';
  end if;
  if p_occurred_at is null then
    raise exception using errcode = '22023', message = 'missing occurrence time';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid runtime actor';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;

  if v_control.kill_switch_active or v_control.ingestion_paused then
    raise exception using errcode = '55000', message = 'runtime ingestion is paused';
  end if;

  v_external_hash := runtime.sha256_text(p_external_event_id);
  v_payload_hash := runtime.sha256_jsonb(p_payload);
  v_workflow_type := coalesce(nullif(p_workflow_type, ''), p_provider || '_event');

  insert into runtime.inbox_events (
    account_id, provider, event_type, external_event_id, external_event_id_hash,
    identity_version, correlation_id, occurred_at, contract_version,
    normalization_result, payload, payload_hash
  ) values (
    p_account_id, p_provider, p_event_type, p_external_event_id, v_external_hash,
    p_identity_version, p_correlation_id, p_occurred_at, p_contract_version,
    'accepted', p_payload, v_payload_hash
  )
  on conflict (account_id, provider, identity_version, external_event_id_hash) do nothing
  returning id into v_inbox_id;

  if v_inbox_id is null then
    select event.id into strict v_inbox_id
    from runtime.inbox_events as event
    where event.account_id = p_account_id
      and event.provider = p_provider
      and event.identity_version = p_identity_version
      and event.external_event_id_hash = v_external_hash;

    if not exists (
      select 1
      from runtime.inbox_events as event
      where event.account_id = p_account_id
        and event.id = v_inbox_id
        and event.external_event_id = p_external_event_id
    ) then
      raise exception using errcode = '23000', message = 'event identity hash collision';
    end if;

    select run.id into v_workflow_id
    from runtime.workflow_runs as run
    where run.account_id = p_account_id
      and run.inbox_event_id = v_inbox_id
    order by run.created_at, run.id
    limit 1;

    if v_workflow_id is null then
      raise exception using errcode = '40001', message = 'duplicate event workflow is unavailable';
    end if;

    return pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'workflow_id', v_workflow_id,
      'inbox_event_id', v_inbox_id
    );
  end if;

  v_created := true;

  insert into runtime.workflow_runs (
    account_id, inbox_event_id, workflow_type, workflow_version,
    execution_mode, correlation_id, current_state
  ) values (
    p_account_id, v_inbox_id, v_workflow_type, p_workflow_version,
    p_execution_mode, p_correlation_id, 'received'
  )
  returning id into v_workflow_id;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, lease_epoch, transition_payload, payload_hash
  ) values (
    p_account_id, v_workflow_id, 1, 'received', 'queued',
    'ingested', 'system', p_actor_id, p_correlation_id,
    p_workflow_version, 0,
    pg_catalog.jsonb_build_object('inbox_event_id', v_inbox_id),
    runtime.sha256_jsonb(pg_catalog.jsonb_build_object('inbox_event_id', v_inbox_id))
  )
  returning id into v_transition_id;

  update runtime.workflow_runs
  set current_state = 'queued', updated_at = clock_timestamp()
  where account_id = p_account_id and id = v_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, event_type, actor_type, actor_id,
    correlation_id, details, payload_hash, runtime_contract_version, workflow_version
  ) values (
    p_account_id, v_workflow_id, v_transition_id, 'runtime.event_ingested',
    'system', p_actor_id, p_correlation_id,
    pg_catalog.jsonb_build_object(
      'provider', p_provider,
      'event_type', p_event_type,
      'execution_mode', p_execution_mode
    ),
    v_payload_hash, 'runtime-v1', p_workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', case when v_created then 'created' else 'duplicate' end,
    'workflow_id', v_workflow_id,
    'inbox_event_id', v_inbox_id
  );
end
$$;

create function public.runtime_claim_workflow(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_execution_mode text default null
)
returns table (
  account_id uuid,
  workflow_id uuid,
  inbox_event_id uuid,
  workflow_type text,
  workflow_version text,
  execution_mode text,
  correlation_id uuid,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer,
  context jsonb,
  event_type text,
  payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_token uuid;
  v_epoch bigint;
  v_seq bigint;
  v_until timestamptz;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid workflow lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid workflow claim limit';
  end if;
  if p_execution_mode is not null and p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'invalid execution mode filter';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;

  if v_control.kill_switch_active or v_control.claims_paused then
    return;
  end if;

  for v_run in
    select run.*
    from runtime.workflow_runs as run
    where run.attempt_count < run.max_attempts
      and (p_execution_mode is null or run.execution_mode = p_execution_mode)
      and (
        run.current_state = 'queued'
        or (run.current_state = 'retry_scheduled' and run.next_attempt_at <= clock_timestamp())
        or (run.current_state = 'running' and run.lease_until <= clock_timestamp())
      )
    order by coalesce(run.next_attempt_at, run.created_at), run.created_at, run.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_epoch := v_run.lease_epoch + 1;
    v_until := clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds);

    select coalesce(max(t.transition_seq), 0) into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = v_run.account_id and t.workflow_id = v_run.id;

    if v_run.current_state = 'retry_scheduled' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'retry_scheduled', 'queued',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    -- An expired running row is reclaimed in-place: its state does not change, but the new epoch
    -- and token fence the zombie worker. Queued/retry rows have a real queued -> running change.
    if v_run.current_state <> 'running' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'queued', 'running',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    update runtime.workflow_runs as run
    set current_state = 'running',
        lease_holder = p_worker_id,
        lease_until = v_until,
        claim_token = v_token,
        lease_epoch = v_epoch,
        attempt_count = run.attempt_count + 1,
        next_attempt_at = null,
        updated_at = clock_timestamp()
    where run.account_id = v_run.account_id and run.id = v_run.id;

    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_run.account_id, v_run.id, 'runtime.workflow_claimed',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'lease_epoch', v_epoch,
        'lease_until', v_until,
        'reclaimed_expired_lease', v_run.current_state = 'running'
      ),
      'runtime-v1', v_run.workflow_version
    );

    return query
    select run.account_id, run.id, run.inbox_event_id, run.workflow_type,
      run.workflow_version, run.execution_mode, run.correlation_id,
      run.claim_token, run.lease_epoch, run.lease_until, run.attempt_count,
      run.context, event.event_type, event.payload
    from runtime.workflow_runs as run
    join runtime.inbox_events as event
      on event.account_id = run.account_id and event.id = run.inbox_event_id
    where run.account_id = v_run.account_id and run.id = v_run.id;
  end loop;
end
$$;

create function public.runtime_transition_workflow(
  p_account_id uuid,
  p_workflow_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_to_state text,
  p_payload jsonb,
  p_actor_id text,
  p_transition_type text default 'checkpoint_saved',
  p_next_attempt_at timestamptz default null,
  p_error_code text default null,
  p_sanitized_error_message text default null,
  p_error_evidence_ref text default null,
  p_terminal_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_transition_id uuid;
  v_seq bigint;
  v_payload_hash text;
  v_terminal boolean;
begin
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid transition actor';
  end if;
  if p_payload is not null and pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'transition payload must be a JSON object';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'running'
    or v_run.lease_epoch <> p_expected_epoch
    or v_run.claim_token is distinct from p_claim_token
    or v_run.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid workflow lease';
  end if;

  if not exists (
    select 1 from runtime.allowed_workflow_transitions as allowed
    where allowed.from_state = v_run.current_state and allowed.to_state = p_to_state
  ) then
    raise exception using errcode = '22023', message = 'invalid workflow state transition';
  end if;

  if p_to_state = 'retry_scheduled' and p_next_attempt_at is null then
    raise exception using errcode = '22023', message = 'retry transition requires next attempt time';
  end if;
  if p_to_state <> 'retry_scheduled' and p_next_attempt_at is not null then
    raise exception using errcode = '22023', message = 'unexpected next attempt time';
  end if;

  v_terminal := p_to_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled');
  if v_terminal and p_to_state <> 'completed' and p_terminal_reason_code is null then
    raise exception using errcode = '22023', message = 'terminal transition requires reason code';
  end if;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

  v_payload_hash := case when p_payload is null then null else runtime.sha256_jsonb(p_payload) end;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, claim_token, lease_epoch,
    transition_payload, payload_hash, evidence_ref
  ) values (
    p_account_id, p_workflow_id, v_seq, v_run.current_state, p_to_state,
    p_transition_type, 'worker', p_actor_id, v_run.correlation_id,
    v_run.workflow_version, p_claim_token, p_expected_epoch,
    p_payload, v_payload_hash, p_error_evidence_ref
  ) returning id into v_transition_id;

  update runtime.workflow_runs as run
  set current_state = p_to_state,
      lease_holder = null,
      lease_until = null,
      claim_token = null,
      next_attempt_at = case when p_to_state = 'retry_scheduled' then p_next_attempt_at else null end,
      last_error_code = p_error_code,
      sanitized_error_message = p_sanitized_error_message,
      error_evidence_ref = p_error_evidence_ref,
      terminal_reason_code = case when v_terminal and p_to_state <> 'completed'
        then p_terminal_reason_code else null end,
      terminal_at = case when v_terminal then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where run.account_id = p_account_id and run.id = p_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, event_type, actor_type, actor_id,
    correlation_id, details, payload_hash, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, 'runtime.workflow_transitioned',
    'worker', p_actor_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object('from_state', v_run.current_state, 'to_state', p_to_state),
    v_payload_hash, 'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'transitioned',
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'state', p_to_state
  );
end
$$;

create function public.runtime_record_policy_decision(
  p_account_id uuid,
  p_workflow_id uuid,
  p_ruleset_id text,
  p_policy_version text,
  p_decision text,
  p_reasons jsonb,
  p_policy_input jsonb,
  p_action_payload jsonb,
  p_actor_id text,
  p_canonicalization_version text default 'postgres-jsonb-v1',
  p_evidence_ref text default null,
  p_approval_summary text default null,
  p_approval_ttl_seconds integer default 86400
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_to_state text;
  v_transition_id uuid;
  v_policy_id uuid;
  v_approval_id uuid;
  v_seq bigint;
  v_input_hash text;
  v_action_hash text;
begin
  if p_decision not in ('allow', 'deny', 'require_approval') then
    raise exception using errcode = '22023', message = 'invalid policy decision';
  end if;
  if p_reasons is null or pg_catalog.jsonb_typeof(p_reasons) <> 'array'
    or p_policy_input is null or pg_catalog.jsonb_typeof(p_policy_input) <> 'object'
    or p_action_payload is null or pg_catalog.jsonb_typeof(p_action_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid policy payload shape';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid policy actor';
  end if;
  if p_approval_ttl_seconds not between 60 and 2592000 then
    raise exception using errcode = '22023', message = 'invalid approval ttl';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'waiting_for_policy' then
    raise exception using errcode = '55000', message = 'workflow is not waiting for policy';
  end if;

  v_to_state := case p_decision
    when 'allow' then 'waiting_for_action'
    when 'require_approval' then 'waiting_for_approval'
    else 'denied'
  end;
  v_input_hash := runtime.sha256_jsonb(p_policy_input);
  v_action_hash := runtime.sha256_jsonb(p_action_payload);

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, policy_version, lease_epoch, transition_payload,
    payload_hash, evidence_ref
  ) values (
    p_account_id, p_workflow_id, v_seq, 'waiting_for_policy', v_to_state,
    'policy_decided', 'system', p_actor_id, v_run.correlation_id,
    v_run.workflow_version, p_policy_version, v_run.lease_epoch,
    pg_catalog.jsonb_build_object('decision', p_decision, 'reasons', p_reasons),
    v_input_hash, p_evidence_ref
  ) returning id into v_transition_id;

  insert into runtime.policy_decisions (
    account_id, workflow_id, transition_id, ruleset_id, policy_version,
    decision, reasons, input_hash, action_payload_hash,
    canonicalization_version, evidence_ref
  ) values (
    p_account_id, p_workflow_id, v_transition_id, p_ruleset_id, p_policy_version,
    p_decision, p_reasons, v_input_hash, v_action_hash,
    p_canonicalization_version, p_evidence_ref
  ) returning id into v_policy_id;

  if p_decision = 'require_approval' then
    insert into public.approval_requests (
      account_id, source, action_type, summary, evidence, status, expires_at,
      workflow_id, transition_id, policy_decision_id, policy_version,
      action_canonicalization_version, action_payload_hash
    ) values (
      p_account_id, 'workflow', 'runtime_external_action',
      left(coalesce(nullif(p_approval_summary, ''), 'Runtime action requires approval'), 240),
      pg_catalog.jsonb_build_object(
        'workflow_id', p_workflow_id,
        'policy_decision_id', v_policy_id,
        'action_payload_hash', v_action_hash
      ),
      'pending', clock_timestamp() + pg_catalog.make_interval(secs => p_approval_ttl_seconds),
      p_workflow_id, v_transition_id, v_policy_id, p_policy_version,
      p_canonicalization_version, v_action_hash
    ) returning id into v_approval_id;
  end if;

  update runtime.workflow_runs as run
  set current_state = v_to_state,
      terminal_reason_code = case when p_decision = 'deny' then 'POLICY_DENIED' else null end,
      terminal_at = case when p_decision = 'deny' then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where run.account_id = p_account_id and run.id = p_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    event_type, actor_type, actor_id, correlation_id, details, payload_hash,
    runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, v_policy_id, v_approval_id,
    'runtime.policy_decided', 'system', p_actor_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object('decision', p_decision, 'ruleset_id', p_ruleset_id),
    v_action_hash, 'runtime-v1', v_run.workflow_version, p_policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'policy_decision_id', v_policy_id,
    'approval_request_id', v_approval_id,
    'state', v_to_state,
    'action_payload_hash', v_action_hash
  );
end
$$;

create function public.runtime_enqueue_outbox_action(
  p_account_id uuid,
  p_workflow_id uuid,
  p_policy_decision_id uuid,
  p_connector_id text,
  p_action_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_actor_id text,
  p_approval_request_id uuid default null,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_policy runtime.policy_decisions%rowtype;
  v_approval public.approval_requests%rowtype;
  v_outbox runtime.outbox_actions%rowtype;
  v_action_hash text;
  v_idempotency_hash text;
  v_status text;
  v_existing boolean := false;
  v_completion_transition_id uuid;
  v_seq bigint;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'outbox payload must be a JSON object';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox actor';
  end if;
  if p_max_attempts not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid outbox max attempts';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'waiting_for_action' then
    raise exception using errcode = '55000', message = 'workflow is not waiting for action';
  end if;

  select decision.* into strict v_policy
  from runtime.policy_decisions as decision
  where decision.account_id = p_account_id
    and decision.workflow_id = p_workflow_id
    and decision.id = p_policy_decision_id;

  if v_policy.decision = 'deny' then
    raise exception using errcode = '55000', message = 'denied action cannot be enqueued';
  end if;

  if v_policy.decision = 'require_approval' then
    if p_approval_request_id is null then
      raise exception using errcode = '55000', message = 'approved request is required';
    end if;
    select request.* into strict v_approval
    from public.approval_requests as request
    where request.account_id = p_account_id
      and request.workflow_id = p_workflow_id
      and request.policy_decision_id = p_policy_decision_id
      and request.id = p_approval_request_id;
    if v_approval.status <> 'approved' or v_approval.outbox_action_id is null then
      raise exception using errcode = '55000', message = 'approval is not linked to an action';
    end if;
    select action.* into strict v_outbox
    from runtime.outbox_actions as action
    where action.account_id = p_account_id and action.id = v_approval.outbox_action_id;
    return pg_catalog.jsonb_build_object(
      'status', 'duplicate', 'outbox_action_id', v_outbox.id,
      'execution_mode', v_outbox.execution_mode, 'outbox_status', v_outbox.status
    );
  end if;

  v_action_hash := runtime.sha256_jsonb(p_payload);
  if v_action_hash <> v_policy.action_payload_hash then
    raise exception using errcode = '22000', message = 'action payload does not match policy decision';
  end if;
  v_idempotency_hash := runtime.sha256_text(p_idempotency_key);
  v_status := case when v_run.execution_mode = 'shadow' then 'simulated' else 'pending' end;

  insert into runtime.outbox_actions (
    account_id, workflow_id, transition_id, policy_decision_id,
    policy_version, connector_id, action_type, execution_mode,
    payload, action_payload_hash, canonicalization_version,
    idempotency_key, idempotency_key_hash, status, max_attempts, completed_at
  ) values (
    p_account_id, p_workflow_id, v_policy.transition_id, p_policy_decision_id,
    v_policy.policy_version, p_connector_id, p_action_type, v_run.execution_mode,
    p_payload, v_action_hash, v_policy.canonicalization_version,
    p_idempotency_key, v_idempotency_hash, v_status, p_max_attempts,
    case when v_status = 'simulated' then clock_timestamp() else null end
  )
  on conflict (account_id, connector_id, idempotency_key_hash) do nothing
  returning * into v_outbox;

  if v_outbox.id is null then
    v_existing := true;
    select action.* into strict v_outbox
    from runtime.outbox_actions as action
    where action.account_id = p_account_id
      and action.connector_id = p_connector_id
      and action.idempotency_key_hash = v_idempotency_hash;
    if v_outbox.workflow_id <> p_workflow_id
      or v_outbox.action_payload_hash <> v_action_hash
      or v_outbox.action_type <> p_action_type then
      raise exception using errcode = '23000', message = 'outbox idempotency collision';
    end if;
  end if;

  if not v_existing then
    insert into runtime.audit_events (
      account_id, workflow_id, transition_id, policy_decision_id, outbox_action_id,
      event_type, actor_type, actor_id, correlation_id, details, payload_hash,
      runtime_contract_version, workflow_version, policy_version
    ) values (
      p_account_id, p_workflow_id, v_policy.transition_id, p_policy_decision_id, v_outbox.id,
      'runtime.outbox_enqueued', 'system', p_actor_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'connector_id', p_connector_id,
        'action_type', p_action_type,
        'execution_mode', v_run.execution_mode,
        'status', v_status
      ),
      v_action_hash, 'runtime-v1', v_run.workflow_version, v_policy.policy_version
    );
  end if;

  if v_status = 'simulated' and v_run.current_state = 'waiting_for_action' then
    select coalesce(max(t.transition_seq), 0) + 1 into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, lease_epoch, transition_payload, payload_hash
    ) values (
      p_account_id, p_workflow_id, v_seq, 'waiting_for_action', 'completed',
      'action_completed', 'system', p_actor_id, v_run.correlation_id,
      v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
      pg_catalog.jsonb_build_object('outbox_action_id', v_outbox.id, 'simulated', true),
      v_action_hash
    ) returning id into v_completion_transition_id;

    update runtime.workflow_runs
    set current_state = 'completed', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    where account_id = p_account_id and id = p_workflow_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', case when v_existing then 'duplicate' else 'created' end,
    'outbox_action_id', v_outbox.id,
    'execution_mode', v_outbox.execution_mode,
    'outbox_status', v_outbox.status,
    'workflow_transition_id', v_completion_transition_id
  );
end
$$;

-- The legacy approval RPC remains responsible for research-review approvals. Runtime approvals
-- must use the atomic resolver below, otherwise an approved row and its required outbox FK could
-- be committed in separate steps (or a rejection could leave the workflow waiting forever).
create or replace function public.decide_approval_request(
  p_account_id uuid,
  p_user_id uuid,
  p_request_id uuid,
  p_decision text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.approval_requests;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid decision';
  end if;
  if not exists (
    select 1 from public.users where id = p_user_id and account_id = p_account_id
  ) then
    raise exception 'invalid owner context';
  end if;

  select * into request_row
  from public.approval_requests
  where id = p_request_id and account_id = p_account_id
    and status = 'pending' and expires_at > pg_catalog.now()
  for update;
  if not found then return false; end if;

  if request_row.workflow_id is not null then
    raise exception using
      errcode = '55000',
      message = 'runtime approval requires the atomic runtime resolver';
  end if;

  update public.approval_requests
  set status = p_decision, decided_by = p_user_id, decided_at = pg_catalog.now()
  where id = request_row.id;

  if request_row.source = 'workflow'
    and request_row.action_type = 'research_quality_review'
    and request_row.related_research_run_id is not null then
    update public.research_runs
    set human_review_status = p_decision,
        human_reviewed_by = p_user_id,
        human_reviewed_at = pg_catalog.now(),
        status = case when p_decision = 'approved' then 'done' else 'review_rejected' end
    where id = request_row.related_research_run_id
      and account_id = p_account_id
      and human_review_status = 'pending';
    if not found then raise exception 'research review is no longer pending'; end if;
  end if;

  return true;
end
$$;

create function public.runtime_resolve_approval_and_enqueue_action(
  p_account_id uuid,
  p_workflow_id uuid,
  p_approval_request_id uuid,
  p_user_id uuid,
  p_decision text,
  p_connector_id text,
  p_action_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_request public.approval_requests%rowtype;
  v_policy runtime.policy_decisions%rowtype;
  v_outbox runtime.outbox_actions%rowtype;
  v_transition_id uuid;
  v_completion_transition_id uuid;
  v_seq bigint;
  v_action_hash text;
  v_idempotency_hash text;
  v_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid approval decision';
  end if;
  if not exists (
    select 1 from public.users as app_user
    where app_user.id = p_user_id and app_user.account_id = p_account_id
  ) then
    raise exception using errcode = '42501', message = 'invalid approval owner context';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  select request.* into strict v_request
  from public.approval_requests as request
  where request.account_id = p_account_id
    and request.workflow_id = p_workflow_id
    and request.id = p_approval_request_id
  for update;

  if v_run.current_state <> 'waiting_for_approval'
    or v_request.status <> 'pending'
    or v_request.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'approval request is not pending';
  end if;

  select decision.* into strict v_policy
  from runtime.policy_decisions as decision
  where decision.account_id = p_account_id
    and decision.workflow_id = p_workflow_id
    and decision.id = v_request.policy_decision_id;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

  if p_decision = 'rejected' then
    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, lease_epoch
    ) values (
      p_account_id, p_workflow_id, v_seq, 'waiting_for_approval', 'denied',
      'approval_resolved', 'user', p_user_id::text, v_run.correlation_id,
      v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch
    ) returning id into v_transition_id;

    update public.approval_requests
    set status = 'rejected', decided_by = p_user_id, decided_at = clock_timestamp()
    where account_id = p_account_id and id = p_approval_request_id;

    update runtime.workflow_runs
    set current_state = 'denied', terminal_reason_code = 'APPROVAL_REJECTED',
        terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    where account_id = p_account_id and id = p_workflow_id;
  else
    if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
      raise exception using errcode = '22023', message = 'approved action payload must be an object';
    end if;
    if p_max_attempts not between 1 and 100 then
      raise exception using errcode = '22023', message = 'invalid outbox max attempts';
    end if;

    v_action_hash := runtime.sha256_jsonb(p_payload);
    if v_action_hash <> v_policy.action_payload_hash
      or v_action_hash <> v_request.action_payload_hash then
      raise exception using errcode = '22000', message = 'approved payload does not match policy decision';
    end if;

    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, lease_epoch, transition_payload, payload_hash
    ) values (
      p_account_id, p_workflow_id, v_seq, 'waiting_for_approval', 'waiting_for_action',
      'approval_resolved', 'user', p_user_id::text, v_run.correlation_id,
      v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
      pg_catalog.jsonb_build_object('approval_request_id', p_approval_request_id),
      v_action_hash
    ) returning id into v_transition_id;

    update runtime.workflow_runs
    set current_state = 'waiting_for_action', updated_at = clock_timestamp()
    where account_id = p_account_id and id = p_workflow_id;

    v_idempotency_hash := runtime.sha256_text(p_idempotency_key);
    v_status := case when v_run.execution_mode = 'shadow' then 'simulated' else 'pending' end;

    insert into runtime.outbox_actions (
      account_id, workflow_id, transition_id, policy_decision_id,
      policy_version, connector_id, action_type, execution_mode,
      payload, action_payload_hash, canonicalization_version,
      idempotency_key, idempotency_key_hash, status, max_attempts, completed_at
    ) values (
      p_account_id, p_workflow_id, v_transition_id, v_policy.id,
      v_policy.policy_version, p_connector_id, p_action_type, v_run.execution_mode,
      p_payload, v_action_hash, v_policy.canonicalization_version,
      p_idempotency_key, v_idempotency_hash, v_status, p_max_attempts,
      case when v_status = 'simulated' then clock_timestamp() else null end
    ) returning * into v_outbox;

    update public.approval_requests
    set status = 'approved', decided_by = p_user_id, decided_at = clock_timestamp(),
        outbox_action_id = v_outbox.id
    where account_id = p_account_id and id = p_approval_request_id;

    update runtime.outbox_actions
    set approval_request_id = p_approval_request_id, updated_at = clock_timestamp()
    where account_id = p_account_id and id = v_outbox.id;

    if v_status = 'simulated' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, policy_version, lease_epoch, transition_payload, payload_hash
      ) values (
        p_account_id, p_workflow_id, v_seq, 'waiting_for_action', 'completed',
        'action_completed', 'system', 'shadow-simulator', v_run.correlation_id,
        v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
        pg_catalog.jsonb_build_object('outbox_action_id', v_outbox.id, 'simulated', true),
        v_action_hash
      ) returning id into v_completion_transition_id;

      update runtime.workflow_runs
      set current_state = 'completed', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
      where account_id = p_account_id and id = p_workflow_id;
    end if;
  end if;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    outbox_action_id, event_type, actor_type, actor_id, correlation_id,
    details, payload_hash, runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, v_policy.id, p_approval_request_id,
    v_outbox.id, 'runtime.approval_resolved', 'user', p_user_id::text, v_run.correlation_id,
    pg_catalog.jsonb_build_object('decision', p_decision, 'outbox_status', v_status),
    v_action_hash, 'runtime-v1', v_run.workflow_version, v_policy.policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', p_decision,
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'outbox_action_id', v_outbox.id,
    'outbox_status', v_status,
    'completion_transition_id', v_completion_transition_id
  );
end
$$;

create function public.runtime_claim_outbox_actions(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_connector_id text default null
)
returns table (
  account_id uuid,
  outbox_action_id uuid,
  workflow_id uuid,
  connector_id text,
  action_type text,
  payload jsonb,
  idempotency_key text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_action runtime.outbox_actions%rowtype;
  v_token uuid;
  v_epoch bigint;
  v_until timestamptz;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid outbox lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid outbox claim limit';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then
    return;
  end if;

  for v_action in
    select action.*
    from runtime.outbox_actions as action
    where action.execution_mode = 'live'
      and action.attempt_count < action.max_attempts
      and (p_connector_id is null or action.connector_id = p_connector_id)
      and (
        action.status = 'pending'
        or (action.status = 'retry_scheduled' and action.next_attempt_at <= clock_timestamp())
        or (action.status = 'processing' and action.lease_until <= clock_timestamp())
      )
      and not exists (
        select 1 from runtime.connector_health as health
        where health.account_id = action.account_id
          and health.connector_id = action.connector_id
          and health.operation = action.action_type
          -- Fail closed. A separate health controller must explicitly close the circuit after a
          -- bounded half-open probe; normal action workers never bypass open/half-open state.
          and health.state in ('open', 'half_open')
      )
    order by coalesce(action.next_attempt_at, action.created_at), action.created_at, action.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_epoch := v_action.lease_epoch + 1;
    v_until := clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds);

    update runtime.outbox_actions as action
    set status = 'processing', claimed_at = clock_timestamp(), lease_until = v_until,
        claim_token = v_token, lease_epoch = v_epoch,
        attempt_count = action.attempt_count + 1, next_attempt_at = null,
        completed_at = null, updated_at = clock_timestamp()
    where action.account_id = v_action.account_id and action.id = v_action.id;

    insert into runtime.audit_events (
      account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
      outbox_action_id, event_type, actor_type, actor_id, correlation_id,
      details, payload_hash, runtime_contract_version, policy_version
    )
    select action.account_id, action.workflow_id, action.transition_id,
      action.policy_decision_id, action.approval_request_id, action.id,
      'runtime.outbox_claimed', 'worker', p_worker_id, run.correlation_id,
      pg_catalog.jsonb_build_object('lease_epoch', v_epoch, 'lease_until', v_until),
      action.action_payload_hash, 'runtime-v1', action.policy_version
    from runtime.outbox_actions as action
    join runtime.workflow_runs as run
      on run.account_id = action.account_id and run.id = action.workflow_id
    where action.account_id = v_action.account_id and action.id = v_action.id;

    return query
    select action.account_id, action.id, action.workflow_id, action.connector_id,
      action.action_type, action.payload, action.idempotency_key,
      action.claim_token, action.lease_epoch, action.lease_until, action.attempt_count
    from runtime.outbox_actions as action
    where action.account_id = v_action.account_id and action.id = v_action.id;
  end loop;
end
$$;

create function public.runtime_finish_outbox_action(
  p_account_id uuid,
  p_outbox_action_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_result_status text,
  p_worker_id text,
  p_next_attempt_at timestamptz default null,
  p_provider_result_ref text default null,
  p_error_code text default null,
  p_sanitized_error_message text default null,
  p_error_evidence_ref text default null,
  p_reconciliation_state text default 'not_required'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action runtime.outbox_actions%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_to_state text;
  v_transition_type text;
  v_transition_id uuid;
  v_seq bigint;
begin
  if p_result_status not in ('completed', 'retry_scheduled', 'failed', 'dead_letter', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid outbox result status';
  end if;
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_result_status = 'retry_scheduled' and p_next_attempt_at is null then
    raise exception using errcode = '22023', message = 'outbox retry requires next attempt time';
  end if;
  if p_result_status <> 'retry_scheduled' and p_next_attempt_at is not null then
    raise exception using errcode = '22023', message = 'unexpected outbox next attempt time';
  end if;
  if p_result_status in ('failed', 'dead_letter') and p_error_code is null then
    raise exception using errcode = '22023', message = 'outbox failure requires error code';
  end if;

  select action.* into strict v_action
  from runtime.outbox_actions as action
  where action.account_id = p_account_id and action.id = p_outbox_action_id
  for update;

  if v_action.status <> 'processing'
    or v_action.lease_epoch <> p_expected_epoch
    or v_action.claim_token is distinct from p_claim_token
    or v_action.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid outbox lease';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = v_action.workflow_id
  for update;

  update runtime.outbox_actions as action
  set status = p_result_status,
      next_attempt_at = case when p_result_status = 'retry_scheduled' then p_next_attempt_at else null end,
      claimed_at = case when p_result_status = 'retry_scheduled' then action.claimed_at else action.claimed_at end,
      lease_until = null,
      claim_token = null,
      completed_at = case when p_result_status in ('completed', 'failed', 'dead_letter', 'cancelled')
        then clock_timestamp() else null end,
      provider_result_ref = p_provider_result_ref,
      reconciliation_state = p_reconciliation_state,
      last_error_code = p_error_code,
      sanitized_error_message = p_sanitized_error_message,
      error_evidence_ref = p_error_evidence_ref,
      updated_at = clock_timestamp()
  where action.account_id = p_account_id and action.id = p_outbox_action_id;

  if p_result_status <> 'retry_scheduled' then
    if v_run.current_state <> 'waiting_for_action' then
      raise exception using errcode = '55000', message = 'workflow is not waiting for outbox action';
    end if;

    v_to_state := case p_result_status
      when 'completed' then 'completed'
      when 'failed' then 'failed'
      when 'dead_letter' then 'dead_letter'
      else 'cancelled'
    end;
    v_transition_type := case p_result_status
      when 'completed' then 'action_completed'
      when 'failed' then 'failed'
      when 'dead_letter' then 'dead_letter'
      else 'cancelled'
    end;

    select coalesce(max(t.transition_seq), 0) + 1 into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = p_account_id and t.workflow_id = v_action.workflow_id;

    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, claim_token, lease_epoch,
      transition_payload, payload_hash, evidence_ref
    ) values (
      p_account_id, v_action.workflow_id, v_seq, 'waiting_for_action', v_to_state,
      v_transition_type, 'worker', p_worker_id, v_run.correlation_id,
      v_run.workflow_version, v_action.policy_version, p_claim_token, p_expected_epoch,
      pg_catalog.jsonb_build_object(
        'outbox_action_id', p_outbox_action_id,
        'result_status', p_result_status,
        'provider_result_ref', p_provider_result_ref
      ),
      v_action.action_payload_hash, p_error_evidence_ref
    ) returning id into v_transition_id;

    update runtime.workflow_runs
    set current_state = v_to_state,
        terminal_reason_code = case when v_to_state = 'completed' then null
          else coalesce(p_error_code, 'OUTBOX_' || upper(p_result_status)) end,
        terminal_at = clock_timestamp(), updated_at = clock_timestamp(),
        last_error_code = p_error_code,
        sanitized_error_message = p_sanitized_error_message,
        error_evidence_ref = p_error_evidence_ref
    where account_id = p_account_id and id = v_action.workflow_id;
  end if;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    outbox_action_id, event_type, actor_type, actor_id, correlation_id,
    details, payload_hash, runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, v_action.workflow_id, v_transition_id, v_action.policy_decision_id,
    v_action.approval_request_id, p_outbox_action_id, 'runtime.outbox_finished',
    'worker', p_worker_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object(
      'result_status', p_result_status,
      'reconciliation_state', p_reconciliation_state
    ),
    v_action.action_payload_hash, 'runtime-v1', v_run.workflow_version, v_action.policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', p_result_status,
    'outbox_action_id', p_outbox_action_id,
    'workflow_id', v_action.workflow_id,
    'workflow_transition_id', v_transition_id
  );
end
$$;

revoke all on function public.runtime_ingest_event(
  uuid, text, text, jsonb, text, uuid, text, timestamptz, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.runtime_claim_workflow(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.runtime_transition_workflow(
  uuid, uuid, bigint, uuid, text, jsonb, text, text, timestamptz, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.runtime_record_policy_decision(
  uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, integer
) from public, anon, authenticated;
revoke all on function public.runtime_enqueue_outbox_action(
  uuid, uuid, uuid, text, text, jsonb, text, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.runtime_resolve_approval_and_enqueue_action(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, text, integer
) from public, anon, authenticated;
revoke all on function public.runtime_claim_outbox_actions(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.runtime_finish_outbox_action(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.runtime_ingest_event(
  uuid, text, text, jsonb, text, uuid, text, timestamptz, text, text, text, text, text
) to service_role;
grant execute on function public.runtime_claim_workflow(text, integer, integer, text)
  to service_role;
grant execute on function public.runtime_transition_workflow(
  uuid, uuid, bigint, uuid, text, jsonb, text, text, timestamptz, text, text, text, text
) to service_role;
grant execute on function public.runtime_record_policy_decision(
  uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, integer
) to service_role;
grant execute on function public.runtime_enqueue_outbox_action(
  uuid, uuid, uuid, text, text, jsonb, text, text, uuid, integer
) to service_role;
grant execute on function public.runtime_resolve_approval_and_enqueue_action(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, text, integer
) to service_role;
grant execute on function public.runtime_claim_outbox_actions(text, integer, integer, text)
  to service_role;
grant execute on function public.runtime_finish_outbox_action(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text, text, text, text
) to service_role;

comment on function public.runtime_ingest_event(
  uuid, text, text, jsonb, text, uuid, text, timestamptz, text, text, text, text, text
) is 'Idempotently ingests a normalized event and creates one queued workflow.';
comment on function public.runtime_claim_workflow(text, integer, integer, text)
  is 'Claims due workflows with SKIP LOCKED and returns fencing tokens.';
comment on function public.runtime_transition_workflow(
  uuid, uuid, bigint, uuid, text, jsonb, text, text, timestamptz, text, text, text, text
) is 'Applies one lease-fenced worker transition and writes immutable audit evidence.';
comment on function public.runtime_claim_outbox_actions(text, integer, integer, text)
  is 'Claims live outbox actions with SKIP LOCKED, circuit-breaker filtering and fencing tokens.';

-- ─── 20260824160000_amocrm_native_webhook_identity.sql ───────────────────────────────────────
-- Native amoCRM webhooks do not carry a documented request signature. Authenticate an inbound
-- webhook with a high-entropy secret embedded in its configured destination URL, but store only
-- the SHA-256 digest. The account subdomain in the form body is a second binding check, not an
-- authenticator by itself.

alter table public.crm_integrations
  add column if not exists inbound_webhook_secret_hash text;

alter table public.crm_integrations
  drop constraint if exists crm_integrations_webhook_secret_hash_shape;

alter table public.crm_integrations
  add constraint crm_integrations_webhook_secret_hash_shape
  check (
    inbound_webhook_secret_hash is null
    or inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'
  );

create unique index if not exists crm_integrations_webhook_secret_hash_unique
  on public.crm_integrations (inbound_webhook_secret_hash)
  where inbound_webhook_secret_hash is not null;

create or replace function public.resolve_amocrm_webhook(
  p_secret_hash text,
  p_account_domain text
)
returns table (
  account_id uuid,
  integration_id uuid,
  account_domain text
)
language sql
stable
security definer
set search_path = ''
as $$
  select integration.tenant_id, integration.id, integration.account_domain
  from public.crm_integrations as integration
  where integration.provider = 'AMOCRM'
    and integration.is_active
    and integration.inbound_webhook_secret_hash = p_secret_hash
    and integration.inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'
    and lower(
      regexp_replace(
        regexp_replace(
          regexp_replace(btrim(integration.account_domain), '^https?://', '', 'i'),
          '/.*$', ''
        ),
        '\.amocrm\.(ru|com)$', '', 'i'
      )
    ) = lower(btrim(p_account_domain))
  limit 1
$$;

revoke all on function public.resolve_amocrm_webhook(text, text) from public, anon, authenticated;
grant execute on function public.resolve_amocrm_webhook(text, text) to service_role;

comment on column public.crm_integrations.inbound_webhook_secret_hash is
  'SHA-256 of the per-integration secret embedded in the native amoCRM webhook destination URL.';
comment on function public.resolve_amocrm_webhook(text, text) is
  'Service-role-only fail-closed mapping of a native amoCRM webhook secret and body subdomain to a Nemo tenant.';

-- ─── 20260824170000_amocrm_webhook_secret_lifecycle.sql ──────────────────────────────────────
-- Phase 3 / Block 1: durable lifecycle for native amoCRM webhook identities.
-- Plaintext webhook secrets never enter PostgreSQL; only lowercase SHA-256 digests are stored.

create table runtime.amocrm_webhook_identities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  subdomain text not null,
  secret_hash text not null unique,
  status text not null default 'active'
    check (status in ('pending', 'active', 'grace', 'revoked')),
  valid_from timestamptz not null default clock_timestamp(),
  expires_at timestamptz,
  revoked_at timestamptz,
  rotated_from_id uuid references runtime.amocrm_webhook_identities(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  last_used_at timestamptz,
  constraint amocrm_webhook_identity_account_id_id_unique unique (account_id, id),
  constraint amocrm_webhook_identity_subdomain_shape check (
    subdomain = lower(subdomain)
    and subdomain ~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
  ),
  constraint amocrm_webhook_identity_hash_shape check (secret_hash ~ '^[0-9a-f]{64}$'),
  constraint amocrm_webhook_identity_lifecycle check (
    (status = 'active' and expires_at is null and revoked_at is null)
    or (status = 'pending' and expires_at is not null and expires_at > valid_from and revoked_at is null)
    or (status = 'grace' and expires_at is not null and expires_at > valid_from and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index amocrm_webhook_identity_one_active
  on runtime.amocrm_webhook_identities (account_id, subdomain)
  where status = 'active';

create unique index amocrm_webhook_identity_one_grace
  on runtime.amocrm_webhook_identities (account_id, subdomain)
  where status = 'grace';

create index amocrm_webhook_identity_resolve
  on runtime.amocrm_webhook_identities (secret_hash, subdomain)
  where status in ('active', 'grace');

revoke all on runtime.amocrm_webhook_identities from public, anon, authenticated;

-- Migrate the single pre-Phase-3 identity before clearing the deprecated column. If historical
-- rows somehow share a hash, the old unique index has already prevented the ambiguity.
insert into runtime.amocrm_webhook_identities (
  account_id, subdomain, secret_hash, status, valid_from, created_at
)
select
  integration.tenant_id,
  lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(btrim(integration.account_domain), '^https?://', '', 'i'),
        '/.*$', ''
      ),
      '\.amocrm\.(ru|com)$', '', 'i'
    )
  ),
  integration.inbound_webhook_secret_hash,
  'active',
  integration.updated_at,
  integration.updated_at
from public.crm_integrations as integration
where integration.provider = 'AMOCRM'
  and integration.is_active
  and integration.inbound_webhook_secret_hash ~ '^[0-9a-f]{64}$'
on conflict (secret_hash) do nothing;

update public.crm_integrations
set inbound_webhook_secret_hash = null
where inbound_webhook_secret_hash is not null;

comment on column public.crm_integrations.inbound_webhook_secret_hash is
  'DEPRECATED Phase 3 compatibility column. Always NULL; identities live in runtime.amocrm_webhook_identities.';

drop function if exists public.resolve_amocrm_webhook(text, text);

create function public.configure_amocrm_webhook_identity(
  p_account_id uuid,
  p_subdomain text,
  p_secret_hash text,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subdomain text;
  v_previous_id uuid;
  v_identity_id uuid;
  v_grace_until timestamptz;
begin
  v_subdomain := lower(btrim(coalesce(p_subdomain, '')));
  if p_account_id is null
    or v_subdomain !~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$'
    or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'invalid amoCRM webhook identity';
  end if;
  if not exists (select 1 from public.accounts as account where account.id = p_account_id) then
    raise exception using errcode = '23503', message = 'unknown account';
  end if;
  if p_created_by is not null and not exists (
    select 1 from public.users as actor
    where actor.id = p_created_by and actor.account_id = p_account_id
  ) then
    raise exception using errcode = '42501', message = 'identity actor is outside account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_subdomain, 0)
  );

  -- At most one old grace identity is retained. A second rotation revokes it immediately so the
  -- partial unique index remains an invariant rather than a best-effort convention.
  update runtime.amocrm_webhook_identities as identity
  set status = 'revoked', revoked_at = clock_timestamp(), expires_at = clock_timestamp()
  where identity.account_id = p_account_id
    and identity.subdomain = v_subdomain
    and identity.status = 'grace';

  select identity.id into v_previous_id
  from runtime.amocrm_webhook_identities as identity
  where identity.account_id = p_account_id
    and identity.subdomain = v_subdomain
    and identity.status = 'active'
  for update;

  if v_previous_id is not null then
    v_grace_until := clock_timestamp() + interval '24 hours';
    update runtime.amocrm_webhook_identities as identity
    set status = 'grace', expires_at = v_grace_until
    where identity.account_id = p_account_id and identity.id = v_previous_id;
  end if;

  insert into runtime.amocrm_webhook_identities (
    account_id, subdomain, secret_hash, status, rotated_from_id, created_by
  ) values (
    p_account_id, v_subdomain, p_secret_hash, 'active', v_previous_id, p_created_by
  )
  returning id into v_identity_id;

  return pg_catalog.jsonb_build_object(
    'identity_id', v_identity_id,
    'subdomain', v_subdomain,
    'status', 'active',
    'previous_valid_until', v_grace_until
  );
end
$$;

create function public.revoke_amocrm_webhook_identity(
  p_account_id uuid,
  p_subdomain text,
  p_identity_id uuid,
  p_revoked_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subdomain text := lower(btrim(coalesce(p_subdomain, '')));
  v_changed integer;
begin
  if p_account_id is null or p_identity_id is null
    or v_subdomain !~ '^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$' then
    raise exception using errcode = '22023', message = 'invalid amoCRM webhook identity';
  end if;
  if p_revoked_by is not null and not exists (
    select 1 from public.users as actor
    where actor.id = p_revoked_by and actor.account_id = p_account_id
  ) then
    raise exception using errcode = '42501', message = 'identity actor is outside account';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_account_id::text || ':' || v_subdomain, 0)
  );

  update runtime.amocrm_webhook_identities as identity
  set status = 'revoked', revoked_at = clock_timestamp(), expires_at = clock_timestamp()
  where identity.account_id = p_account_id
    and identity.subdomain = v_subdomain
    and identity.id = p_identity_id
    and identity.status <> 'revoked';
  get diagnostics v_changed = row_count;

  return pg_catalog.jsonb_build_object('revoked', v_changed = 1, 'identity_id', p_identity_id);
end
$$;

create function public.resolve_amocrm_webhook(
  p_subdomain text,
  p_secret_hash text
)
returns table (
  account_id uuid,
  identity_id uuid,
  subdomain text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Unknown hash and wrong subdomain deliberately share the same empty result contract. The gateway
  -- reflects only one generic 401 response and never reveals which half of the binding failed.
  return query
  update runtime.amocrm_webhook_identities as identity
  set last_used_at = clock_timestamp()
  where identity.secret_hash = p_secret_hash
    and identity.subdomain = lower(btrim(coalesce(p_subdomain, '')))
    and (
      identity.status = 'active'
      or (identity.status = 'grace' and identity.expires_at > clock_timestamp())
    )
    and identity.valid_from <= clock_timestamp()
  returning identity.account_id, identity.id, identity.subdomain;
end
$$;

create function public.get_amocrm_webhook_identity_status(
  p_account_id uuid,
  p_subdomain text
)
returns table (
  identity_id uuid,
  status text,
  valid_from timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  last_used_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select identity.id, identity.status, identity.valid_from, identity.expires_at,
         identity.created_at, identity.last_used_at
  from runtime.amocrm_webhook_identities as identity
  where identity.account_id = p_account_id
    and identity.subdomain = lower(btrim(coalesce(p_subdomain, '')))
  order by identity.created_at desc, identity.id
$$;

revoke all on function public.configure_amocrm_webhook_identity(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.revoke_amocrm_webhook_identity(uuid, text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.resolve_amocrm_webhook(text, text)
  from public, anon, authenticated;
revoke all on function public.get_amocrm_webhook_identity_status(uuid, text)
  from public, anon, authenticated;

grant execute on function public.configure_amocrm_webhook_identity(uuid, text, text, uuid) to service_role;
grant execute on function public.revoke_amocrm_webhook_identity(uuid, text, uuid, uuid) to service_role;
grant execute on function public.resolve_amocrm_webhook(text, text) to service_role;
grant execute on function public.get_amocrm_webhook_identity_status(uuid, text) to service_role;

comment on table runtime.amocrm_webhook_identities is
  'Hashed native amoCRM webhook identities with one active and one bounded grace key per tenant/subdomain.';

-- ─── 20260824180000_durable_runtime_phase3_context_and_circuit.sql ───────────────────────────
-- Durable Operations Runtime Phase 3A: typed claims, context checkpoints, and fenced connector permits.

drop function if exists public.runtime_claim_workflow(text, integer, integer, text);

create function public.runtime_claim_workflow(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_execution_mode text default null,
  p_workflow_type text default null
)
returns table (
  account_id uuid,
  workflow_id uuid,
  inbox_event_id uuid,
  workflow_type text,
  workflow_version text,
  execution_mode text,
  correlation_id uuid,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer,
  context jsonb,
  event_type text,
  payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_token uuid;
  v_epoch bigint;
  v_seq bigint;
  v_until timestamptz;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid workflow lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid workflow claim limit';
  end if;
  if p_execution_mode is not null and p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'invalid execution mode filter';
  end if;
  if p_workflow_type is not null and (
    char_length(p_workflow_type) not between 1 and 128
    or p_workflow_type !~ '^[a-z][a-z0-9_]{0,127}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid workflow type filter';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;

  if v_control.kill_switch_active or v_control.claims_paused then
    return;
  end if;

  for v_run in
    select run.*
    from runtime.workflow_runs as run
    where run.attempt_count < run.max_attempts
      and (p_execution_mode is null or run.execution_mode = p_execution_mode)
      and (p_workflow_type is null or run.workflow_type = p_workflow_type)
      and (
        run.current_state = 'queued'
        or (run.current_state = 'retry_scheduled' and run.next_attempt_at <= clock_timestamp())
        or (run.current_state = 'running' and run.lease_until <= clock_timestamp())
      )
    order by coalesce(run.next_attempt_at, run.created_at), run.created_at, run.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_epoch := v_run.lease_epoch + 1;
    v_until := clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds);

    select coalesce(max(t.transition_seq), 0) into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = v_run.account_id and t.workflow_id = v_run.id;

    if v_run.current_state = 'retry_scheduled' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'retry_scheduled', 'queued',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    if v_run.current_state <> 'running' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'queued', 'running',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    update runtime.workflow_runs as run
    set current_state = 'running',
        lease_holder = p_worker_id,
        lease_until = v_until,
        claim_token = v_token,
        lease_epoch = v_epoch,
        attempt_count = run.attempt_count + 1,
        next_attempt_at = null,
        updated_at = clock_timestamp()
    where run.account_id = v_run.account_id and run.id = v_run.id;

    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_run.account_id, v_run.id, 'runtime.workflow_claimed',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'lease_epoch', v_epoch,
        'lease_until', v_until,
        'workflow_type_filter', p_workflow_type,
        'reclaimed_expired_lease', v_run.current_state = 'running'
      ),
      'runtime-v1', v_run.workflow_version
    );

    return query
    select run.account_id, run.id, run.inbox_event_id, run.workflow_type,
      run.workflow_version, run.execution_mode, run.correlation_id,
      run.claim_token, run.lease_epoch, run.lease_until, run.attempt_count,
      run.context, event.event_type, event.payload
    from runtime.workflow_runs as run
    join runtime.inbox_events as event
      on event.account_id = run.account_id and event.id = run.inbox_event_id
    where run.account_id = v_run.account_id and run.id = v_run.id;
  end loop;
end
$$;

create function public.runtime_checkpoint_and_transition(
  p_account_id uuid,
  p_workflow_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_context_patch jsonb,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_context jsonb;
  v_transition_id uuid;
  v_seq bigint;
  v_patch_hash text;
begin
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid checkpoint actor';
  end if;
  if p_context_patch is null or pg_catalog.jsonb_typeof(p_context_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'context patch must be a JSON object';
  end if;
  if pg_catalog.octet_length(p_context_patch::text) > 65536 then
    raise exception using errcode = '22023', message = 'context patch exceeds size limit';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'running'
    or v_run.lease_epoch <> p_expected_epoch
    or v_run.claim_token is distinct from p_claim_token
    or v_run.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid workflow lease';
  end if;

  if not exists (
    select 1 from runtime.allowed_workflow_transitions as allowed
    where allowed.from_state = 'running' and allowed.to_state = 'waiting_for_policy'
  ) then
    raise exception using errcode = '55000', message = 'required workflow transition is unavailable';
  end if;

  v_context := v_run.context || p_context_patch;
  if pg_catalog.octet_length(v_context::text) > 65536 then
    raise exception using errcode = '22023', message = 'merged workflow context exceeds size limit';
  end if;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;
  v_patch_hash := runtime.sha256_jsonb(p_context_patch);

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, claim_token, lease_epoch, transition_payload, payload_hash
  ) values (
    p_account_id, p_workflow_id, v_seq, 'running', 'waiting_for_policy',
    'checkpoint_saved', 'worker', p_actor_id, v_run.correlation_id,
    v_run.workflow_version, p_claim_token, p_expected_epoch, p_context_patch, v_patch_hash
  ) returning id into v_transition_id;

  update runtime.workflow_runs as run
  set current_state = 'waiting_for_policy',
      context = v_context,
      lease_holder = null,
      lease_until = null,
      claim_token = null,
      updated_at = clock_timestamp()
  where run.account_id = p_account_id and run.id = p_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, event_type, actor_type, actor_id,
    correlation_id, details, payload_hash, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, 'runtime.context_checkpointed',
    'worker', p_actor_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object('from_state', 'running', 'to_state', 'waiting_for_policy'),
    v_patch_hash, 'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'checkpointed',
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'state', 'waiting_for_policy',
    'context', v_context
  );
end
$$;

create table runtime.connector_permits (
  permit_token uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  connector_health_id uuid not null,
  connector_id text not null,
  operation text not null,
  is_probe boolean not null default false,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint connector_permits_health_fkey foreign key (account_id, connector_health_id)
    references runtime.connector_health(account_id, id) on delete restrict,
  constraint connector_permits_shape_check check (
    char_length(connector_id) between 1 and 160
    and char_length(operation) between 1 and 128
    and expires_at > created_at
  )
);

create unique index connector_permits_one_live_probe_idx
  on runtime.connector_permits (account_id, connector_health_id)
  where is_probe and consumed_at is null;

create index connector_permits_expiry_idx
  on runtime.connector_permits (expires_at)
  where consumed_at is null;

create function public.runtime_acquire_connector_permit(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_ttl_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_health runtime.connector_health%rowtype;
  v_token uuid;
  v_is_probe boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_connector_id is null or char_length(p_connector_id) not between 1 and 160
    or p_operation is null or char_length(p_operation) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid connector permit identity';
  end if;
  if p_permit_ttl_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'invalid connector permit ttl';
  end if;

  insert into runtime.connector_health (account_id, connector_id, operation)
  values (p_account_id, p_connector_id, p_operation)
  on conflict (account_id, connector_id, operation) do nothing;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id
    and health.connector_id = p_connector_id
    and health.operation = p_operation
  for update;

  update runtime.connector_permits
  set consumed_at = v_now
  where account_id = p_account_id
    and connector_health_id = v_health.id
    and consumed_at is null
    and expires_at <= v_now;

  if v_health.state = 'open' and v_health.opened_until > v_now then
    return pg_catalog.jsonb_build_object(
      'allowed', false, 'state', 'open', 'retry_at', v_health.opened_until
    );
  end if;

  if v_health.state = 'half_open' then
    return pg_catalog.jsonb_build_object(
      'allowed', false, 'state', 'half_open', 'retry_at', v_health.opened_until
    );
  end if;

  v_token := gen_random_uuid();
  if v_health.state = 'open' then
    v_is_probe := true;
    update runtime.connector_health
    set state = 'half_open', half_open_probe_token = v_token, updated_at = v_now
    where account_id = p_account_id and id = v_health.id;
  end if;

  insert into runtime.connector_permits (
    permit_token, account_id, connector_health_id, connector_id, operation,
    is_probe, expires_at
  ) values (
    v_token, p_account_id, v_health.id, p_connector_id, p_operation,
    v_is_probe, v_now + pg_catalog.make_interval(secs => p_permit_ttl_seconds)
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'state', case when v_is_probe then 'half_open' else 'closed' end,
    'permit_token', v_token,
    'probe_token', case when v_is_probe then v_token else null end,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_permit_ttl_seconds)
  );
end
$$;

create function public.runtime_record_connector_success(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_permit runtime.connector_permits%rowtype;
  v_health runtime.connector_health%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select permit.* into strict v_permit
  from runtime.connector_permits as permit
  where permit.account_id = p_account_id
    and permit.permit_token = p_permit_token
    and permit.connector_id = p_connector_id
    and permit.operation = p_operation
  for update;
  if v_permit.consumed_at is not null or v_permit.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'invalid or expired connector permit';
  end if;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id and health.id = v_permit.connector_health_id
  for update;
  if v_permit.is_probe and (
    v_health.state <> 'half_open' or v_health.half_open_probe_token is distinct from p_permit_token
  ) then
    raise exception using errcode = '55000', message = 'stale connector probe';
  end if;

  update runtime.connector_permits set consumed_at = v_now
  where permit_token = p_permit_token;
  update runtime.connector_health
  set state = 'closed', consecutive_failures = 0,
      failure_window_started_at = null, opened_until = null,
      half_open_probe_token = null, last_success_at = v_now, updated_at = v_now
  where account_id = p_account_id and id = v_health.id;

  return pg_catalog.jsonb_build_object('status', 'recorded', 'state', 'closed');
end
$$;

create function public.runtime_record_connector_failure(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_permit runtime.connector_permits%rowtype;
  v_health runtime.connector_health%rowtype;
  v_now timestamptz := clock_timestamp();
  v_failures integer;
  v_open boolean;
  v_until timestamptz;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid connector error code';
  end if;
  select permit.* into strict v_permit
  from runtime.connector_permits as permit
  where permit.account_id = p_account_id
    and permit.permit_token = p_permit_token
    and permit.connector_id = p_connector_id
    and permit.operation = p_operation
  for update;
  if v_permit.consumed_at is not null or v_permit.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'invalid or expired connector permit';
  end if;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id and health.id = v_permit.connector_health_id
  for update;
  if v_permit.is_probe and (
    v_health.state <> 'half_open' or v_health.half_open_probe_token is distinct from p_permit_token
  ) then
    raise exception using errcode = '55000', message = 'stale connector probe';
  end if;

  v_failures := v_health.consecutive_failures + 1;
  v_open := v_permit.is_probe or v_failures >= v_health.failure_threshold;
  v_until := case when v_open
    then v_now + pg_catalog.make_interval(secs => v_health.cooldown_seconds)
    else null end;

  update runtime.connector_permits set consumed_at = v_now
  where permit_token = p_permit_token;
  update runtime.connector_health
  set state = case when v_open then 'open' else 'closed' end,
      consecutive_failures = v_failures,
      failure_window_started_at = coalesce(failure_window_started_at, v_now),
      opened_until = v_until,
      half_open_probe_token = null,
      last_failure_at = v_now,
      tripped_at = case when v_open then v_now else tripped_at end,
      updated_at = v_now
  where account_id = p_account_id and id = v_health.id;

  return pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'state', case when v_open then 'open' else 'closed' end,
    'consecutive_failures', v_failures,
    'retry_at', v_until
  );
end
$$;

revoke all on table runtime.connector_permits from public, anon, authenticated;
revoke all on function public.runtime_claim_workflow(text, integer, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.runtime_checkpoint_and_transition(uuid, uuid, bigint, uuid, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.runtime_acquire_connector_permit(uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.runtime_record_connector_success(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.runtime_record_connector_failure(uuid, text, text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.runtime_claim_workflow(text, integer, integer, text, text)
  to service_role;
grant execute on function public.runtime_checkpoint_and_transition(uuid, uuid, bigint, uuid, jsonb, text)
  to service_role;
grant execute on function public.runtime_acquire_connector_permit(uuid, text, text, integer)
  to service_role;
grant execute on function public.runtime_record_connector_success(uuid, text, text, uuid)
  to service_role;
grant execute on function public.runtime_record_connector_failure(uuid, text, text, uuid, text)
  to service_role;

comment on function public.runtime_claim_workflow(text, integer, integer, text, text)
  is 'Claims fenced workflow leases with optional execution-mode and validated workflow-type filters.';
comment on function public.runtime_checkpoint_and_transition(uuid, uuid, bigint, uuid, jsonb, text)
  is 'Atomically shallow-merges a bounded context patch and moves a fenced running workflow to policy review.';
comment on table runtime.connector_permits
  is 'Short-lived, single-use fencing permits for connector calls; half-open breakers admit exactly one probe.';

-- ─── 20260824190000_circuit_breaker_self_healing.sql ─────────────────────────────────────────
-- Review hardening: recover abandoned half-open probes and expose the persisted attempt limit.

create or replace function public.runtime_acquire_connector_permit(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_ttl_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_health runtime.connector_health%rowtype;
  v_token uuid;
  v_is_probe boolean := false;
  v_now timestamptz := clock_timestamp();
  v_retry_at timestamptz;
begin
  if p_connector_id is null or char_length(p_connector_id) not between 1 and 160
    or p_operation is null or char_length(p_operation) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid connector permit identity';
  end if;
  if p_permit_ttl_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'invalid connector permit ttl';
  end if;

  insert into runtime.connector_health (account_id, connector_id, operation)
  values (p_account_id, p_connector_id, p_operation)
  on conflict (account_id, connector_id, operation) do nothing;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id
    and health.connector_id = p_connector_id
    and health.operation = p_operation
  for update;

  -- Expiry is consumed under the same connector-health row lock as state recovery. This makes a
  -- probe crash self-healing while preserving the one-live-probe partial unique index.
  update runtime.connector_permits
  set consumed_at = v_now
  where account_id = p_account_id
    and connector_health_id = v_health.id
    and consumed_at is null
    and expires_at <= v_now;

  if v_health.state = 'half_open' and not exists (
    select 1
    from runtime.connector_permits as permit
    where permit.account_id = p_account_id
      and permit.connector_health_id = v_health.id
      and permit.is_probe
      and permit.permit_token = v_health.half_open_probe_token
      and permit.consumed_at is null
      and permit.expires_at > v_now
  ) then
    v_retry_at := v_now + pg_catalog.make_interval(secs => v_health.cooldown_seconds);
    update runtime.connector_health
    set state = 'open',
        opened_until = v_retry_at,
        half_open_probe_token = null,
        updated_at = v_now
    where account_id = p_account_id and id = v_health.id;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'state', 'open',
      'retry_at', v_retry_at,
      'recovered_abandoned_probe', true
    );
  end if;

  if v_health.state = 'open' and v_health.opened_until > v_now then
    return pg_catalog.jsonb_build_object(
      'allowed', false, 'state', 'open', 'retry_at', v_health.opened_until
    );
  end if;

  if v_health.state = 'half_open' then
    return pg_catalog.jsonb_build_object(
      'allowed', false, 'state', 'half_open', 'retry_at', v_health.opened_until
    );
  end if;

  v_token := gen_random_uuid();
  if v_health.state = 'open' then
    v_is_probe := true;
    update runtime.connector_health
    set state = 'half_open', half_open_probe_token = v_token, updated_at = v_now
    where account_id = p_account_id and id = v_health.id;
  end if;

  insert into runtime.connector_permits (
    permit_token, account_id, connector_health_id, connector_id, operation,
    is_probe, expires_at
  ) values (
    v_token, p_account_id, v_health.id, p_connector_id, p_operation,
    v_is_probe, v_now + pg_catalog.make_interval(secs => p_permit_ttl_seconds)
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'state', case when v_is_probe then 'half_open' else 'closed' end,
    'permit_token', v_token,
    'probe_token', case when v_is_probe then v_token else null end,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_permit_ttl_seconds)
  );
end
$$;

-- PostgreSQL cannot change a TABLE return shape with CREATE OR REPLACE. Recreate the one canonical
-- overload and immediately restore its service-role-only grant.
drop function public.runtime_claim_workflow(text, integer, integer, text, text);

create function public.runtime_claim_workflow(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_execution_mode text default null,
  p_workflow_type text default null
)
returns table (
  account_id uuid,
  workflow_id uuid,
  inbox_event_id uuid,
  workflow_type text,
  workflow_version text,
  execution_mode text,
  correlation_id uuid,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer,
  max_attempts integer,
  context jsonb,
  event_type text,
  payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_token uuid;
  v_epoch bigint;
  v_seq bigint;
  v_until timestamptz;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid workflow lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid workflow claim limit';
  end if;
  if p_execution_mode is not null and p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'invalid execution mode filter';
  end if;
  if p_workflow_type is not null and (
    char_length(p_workflow_type) not between 1 and 128
    or p_workflow_type !~ '^[a-z][a-z0-9_]{0,127}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid workflow type filter';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then return; end if;

  for v_run in
    select run.*
    from runtime.workflow_runs as run
    where run.attempt_count < run.max_attempts
      and (p_execution_mode is null or run.execution_mode = p_execution_mode)
      and (p_workflow_type is null or run.workflow_type = p_workflow_type)
      and (
        run.current_state = 'queued'
        or (run.current_state = 'retry_scheduled' and run.next_attempt_at <= clock_timestamp())
        or (run.current_state = 'running' and run.lease_until <= clock_timestamp())
      )
    order by coalesce(run.next_attempt_at, run.created_at), run.created_at, run.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_epoch := v_run.lease_epoch + 1;
    v_until := clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds);

    select coalesce(max(t.transition_seq), 0) into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = v_run.account_id and t.workflow_id = v_run.id;

    if v_run.current_state = 'retry_scheduled' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'retry_scheduled', 'queued',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    if v_run.current_state <> 'running' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'queued', 'running',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    update runtime.workflow_runs as run
    set current_state = 'running',
        lease_holder = p_worker_id,
        lease_until = v_until,
        claim_token = v_token,
        lease_epoch = v_epoch,
        attempt_count = run.attempt_count + 1,
        next_attempt_at = null,
        updated_at = clock_timestamp()
    where run.account_id = v_run.account_id and run.id = v_run.id;

    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_run.account_id, v_run.id, 'runtime.workflow_claimed',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'lease_epoch', v_epoch,
        'lease_until', v_until,
        'workflow_type_filter', p_workflow_type,
        'reclaimed_expired_lease', v_run.current_state = 'running'
      ),
      'runtime-v1', v_run.workflow_version
    );

    return query
    select run.account_id, run.id, run.inbox_event_id, run.workflow_type,
      run.workflow_version, run.execution_mode, run.correlation_id,
      run.claim_token, run.lease_epoch, run.lease_until, run.attempt_count,
      run.max_attempts, run.context, event.event_type, event.payload
    from runtime.workflow_runs as run
    join runtime.inbox_events as event
      on event.account_id = run.account_id and event.id = run.inbox_event_id
    where run.account_id = v_run.account_id and run.id = v_run.id;
  end loop;
end
$$;

revoke all on function public.runtime_claim_workflow(text, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.runtime_claim_workflow(text, integer, integer, text, text)
  to service_role;

comment on function public.runtime_acquire_connector_permit(uuid, text, text, integer)
  is 'Issues fenced connector permits and self-heals abandoned half-open probes after permit expiry.';
comment on function public.runtime_claim_workflow(text, integer, integer, text, text)
  is 'Claims fenced workflow leases and returns the persisted attempt limit for exhaustion handling.';

-- ─── 20260824200000_compute_jobs_and_sandbox.sql ─────────────────────────────────────────────
-- ADR 002 Stage 0: durable, tenant-safe compute jobs separated from external side effects.

create table runtime.compute_jobs (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null,
  account_id uuid not null,
  profile text not null,
  status text not null default 'pending',
  claim_token uuid,
  lease_holder text,
  lease_until timestamptz,
  lease_epoch bigint not null default 0,
  input_payload jsonb not null,
  result_manifest jsonb,
  error_code text,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint compute_jobs_account_id_id_key unique (account_id, id),
  constraint compute_jobs_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint compute_jobs_profile_check check (profile in (
    'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU'
  )),
  constraint compute_jobs_status_check check (status in (
    'pending', 'running', 'completed', 'failed', 'dead_letter'
  )),
  constraint compute_jobs_epoch_check check (lease_epoch >= 0),
  constraint compute_jobs_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts
  ),
  constraint compute_jobs_input_object_check check (jsonb_typeof(input_payload) = 'object'),
  constraint compute_jobs_input_size_check check (octet_length(input_payload::text) <= 65536),
  constraint compute_jobs_result_object_check check (
    result_manifest is null or jsonb_typeof(result_manifest) = 'object'
  ),
  constraint compute_jobs_result_size_check check (
    result_manifest is null or octet_length(result_manifest::text) <= 262144
  ),
  constraint compute_jobs_error_code_check check (
    error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint compute_jobs_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint compute_jobs_lease_integrity_check check (
    (status = 'running' and claim_token is not null and lease_holder is not null and lease_until is not null)
    or (status <> 'running' and claim_token is null and lease_holder is null and lease_until is null)
  ),
  constraint compute_jobs_result_integrity_check check (
    (status = 'pending' and result_manifest is null)
    or (status = 'running' and result_manifest is null and error_code is null)
    or (status = 'completed' and result_manifest is not null and error_code is null)
    or (status in ('failed', 'dead_letter') and result_manifest is null and error_code is not null)
  )
);

create index compute_jobs_pending_idx
  on runtime.compute_jobs (profile, created_at, id)
  where status = 'pending';

create index compute_jobs_expired_lease_idx
  on runtime.compute_jobs (profile, lease_until, id)
  where status = 'running';

create index compute_jobs_workflow_idx
  on runtime.compute_jobs (account_id, workflow_id, created_at desc);

create function public.runtime_enqueue_compute_job(
  p_account_id uuid,
  p_workflow_id uuid,
  p_profile text,
  p_input_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_job_id uuid;
begin
  if p_profile not in ('PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU') then
    raise exception using errcode = '22023', message = 'invalid compute profile';
  end if;
  if p_input_payload is null or pg_catalog.jsonb_typeof(p_input_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'compute input must be a JSON object';
  end if;
  if pg_catalog.octet_length(p_input_payload::text) > 65536 then
    raise exception using errcode = '22023', message = 'compute input exceeds size limit';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for share;

  if v_run.current_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled') then
    raise exception using errcode = '55000', message = 'terminal workflow cannot enqueue compute';
  end if;

  insert into runtime.compute_jobs (account_id, workflow_id, profile, input_payload)
  values (p_account_id, p_workflow_id, p_profile, p_input_payload)
  returning id into v_job_id;

  insert into runtime.audit_events (
    account_id, workflow_id, event_type, actor_type, actor_id,
    correlation_id, details, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, 'runtime.compute_job_enqueued',
    'system', 'runtime_enqueue_compute_job', v_run.correlation_id,
    pg_catalog.jsonb_build_object('job_id', v_job_id, 'profile', p_profile),
    'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'pending', 'job_id', v_job_id, 'workflow_id', p_workflow_id, 'profile', p_profile
  );
end
$$;

create function public.runtime_claim_compute_jobs(
  p_worker_id text,
  p_lease_duration_seconds integer default 30,
  p_limit integer default 1,
  p_profile text default 'PROFILE_A_WASI'
)
returns table (
  account_id uuid,
  job_id uuid,
  workflow_id uuid,
  profile text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer,
  max_attempts integer,
  input_payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_job runtime.compute_jobs%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_token uuid;
  v_until timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid compute worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid compute lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid compute claim limit';
  end if;
  if p_profile not in ('PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU') then
    raise exception using errcode = '22023', message = 'invalid compute profile filter';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then return; end if;

  -- A crashed worker on its final permitted attempt must become visible, not remain an unclaimable
  -- expired running row forever.
  for v_job in
    update runtime.compute_jobs as job
    set status = 'dead_letter',
        claim_token = null,
        lease_holder = null,
        lease_until = null,
        error_code = 'LEASE_ATTEMPTS_EXHAUSTED',
        updated_at = v_now
    where job.profile = p_profile
      and job.status = 'running'
      and job.lease_until <= v_now
      and job.attempt_count >= job.max_attempts
    returning job.*
  loop
    select run.* into strict v_run
    from runtime.workflow_runs as run
    where run.account_id = v_job.account_id and run.id = v_job.workflow_id;
    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_job.account_id, v_job.workflow_id, 'runtime.compute_job_dead_lettered',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object('job_id', v_job.id, 'error_code', 'LEASE_ATTEMPTS_EXHAUSTED'),
      'runtime-v1', v_run.workflow_version
    );
  end loop;

  for v_job in
    select job.*
    from runtime.compute_jobs as job
    where job.profile = p_profile
      and job.attempt_count < job.max_attempts
      and (
        job.status = 'pending'
        or (job.status = 'running' and job.lease_until <= v_now)
      )
    order by job.created_at, job.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_until := v_now + pg_catalog.make_interval(secs => p_lease_duration_seconds);
    update runtime.compute_jobs as job
    set status = 'running',
        claim_token = v_token,
        lease_holder = p_worker_id,
        lease_until = v_until,
        lease_epoch = job.lease_epoch + 1,
        attempt_count = job.attempt_count + 1,
        error_code = null,
        updated_at = v_now
    where job.account_id = v_job.account_id and job.id = v_job.id
    returning job.* into v_job;

    select run.* into strict v_run
    from runtime.workflow_runs as run
    where run.account_id = v_job.account_id and run.id = v_job.workflow_id;
    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_job.account_id, v_job.workflow_id, 'runtime.compute_job_claimed',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'job_id', v_job.id, 'profile', v_job.profile,
        'lease_epoch', v_job.lease_epoch, 'lease_until', v_job.lease_until
      ),
      'runtime-v1', v_run.workflow_version
    );

    return query select
      v_job.account_id, v_job.id, v_job.workflow_id, v_job.profile,
      v_job.claim_token, v_job.lease_epoch, v_job.lease_until,
      v_job.attempt_count, v_job.max_attempts, v_job.input_payload;
  end loop;
end
$$;

create function public.runtime_finish_compute_job(
  p_account_id uuid,
  p_job_id uuid,
  p_claim_token uuid,
  p_expected_epoch bigint,
  p_status text,
  p_result_manifest jsonb default null,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job runtime.compute_jobs%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_effective_status text := p_status;
begin
  if p_status not in ('pending', 'completed', 'failed', 'dead_letter') then
    raise exception using errcode = '22023', message = 'invalid compute finish status';
  end if;
  if p_status = 'completed' then
    if p_result_manifest is null or pg_catalog.jsonb_typeof(p_result_manifest) <> 'object'
      or p_error_code is not null then
      raise exception using errcode = '22023', message = 'completed compute requires a result manifest only';
    end if;
    if pg_catalog.octet_length(p_result_manifest::text) > 262144 then
      raise exception using errcode = '22023', message = 'compute result exceeds size limit';
    end if;
  elsif p_result_manifest is not null
    or p_error_code is null
    or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'failed compute requires a sanitized error code only';
  end if;

  select job.* into strict v_job
  from runtime.compute_jobs as job
  where job.account_id = p_account_id and job.id = p_job_id
  for update;
  if v_job.status <> 'running'
    or v_job.claim_token is distinct from p_claim_token
    or v_job.lease_epoch <> p_expected_epoch
    or v_job.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid compute lease';
  end if;
  if p_status = 'pending' and v_job.attempt_count >= v_job.max_attempts then
    v_effective_status := 'dead_letter';
  end if;

  update runtime.compute_jobs as job
  set status = v_effective_status,
      claim_token = null,
      lease_holder = null,
      lease_until = null,
      result_manifest = case when v_effective_status = 'completed' then p_result_manifest else null end,
      error_code = case when v_effective_status = 'completed' then null else p_error_code end,
      updated_at = clock_timestamp()
  where job.account_id = p_account_id and job.id = p_job_id;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = v_job.account_id and run.id = v_job.workflow_id;
  insert into runtime.audit_events (
    account_id, workflow_id, event_type, actor_type, actor_id,
    correlation_id, details, runtime_contract_version, workflow_version
  ) values (
    v_job.account_id, v_job.workflow_id, 'runtime.compute_job_finished',
    'worker', v_job.lease_holder, v_run.correlation_id,
    pg_catalog.jsonb_build_object(
      'job_id', v_job.id, 'status', v_effective_status,
      'error_code', p_error_code,
      'result_hash', case when p_result_manifest is null then null else runtime.sha256_jsonb(p_result_manifest) end
    ),
    'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', v_effective_status, 'job_id', p_job_id, 'workflow_id', v_job.workflow_id
  );
end
$$;

revoke all on table runtime.compute_jobs from public, anon, authenticated;
revoke all on function public.runtime_enqueue_compute_job(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.runtime_claim_compute_jobs(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.runtime_finish_compute_job(uuid, uuid, uuid, bigint, text, jsonb, text)
  from public, anon, authenticated;

grant execute on function public.runtime_enqueue_compute_job(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.runtime_claim_compute_jobs(text, integer, integer, text) to service_role;
grant execute on function public.runtime_finish_compute_job(uuid, uuid, uuid, bigint, text, jsonb, text)
  to service_role;

comment on table runtime.compute_jobs
  is 'ADR 002 fenced compute queue; distinct from external transactional outbox side effects.';

-- ─── 20260825000000_vision_device_identities.sql ─────────────────────────────────────────────
-- ADR 002 Stage 3: tenant-bound camera identities. The gateway receives only an encrypted HMAC
-- key and tables remain invisible to PostgREST/browser roles.

create table runtime.vision_device_identities (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  device_id text not null,
  secret_encrypted text not null,
  status text not null default 'active',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  constraint vision_device_id_shape check (
    char_length(device_id) between 1 and 160
    and device_id ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint vision_device_secret_encrypted check (
    secret_encrypted like 'enc:v2:%' and char_length(secret_encrypted) between 64 and 4096
  ),
  constraint vision_device_status check (status in ('active', 'revoked')),
  constraint vision_device_revocation_consistency check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  ),
  constraint vision_device_global_identity unique (device_id),
  constraint vision_device_account_identity unique (account_id, device_id)
);

revoke all on table runtime.vision_device_identities from public, anon, authenticated;

create function public.runtime_configure_vision_device_identity(
  p_account_id uuid,
  p_device_id text,
  p_secret_encrypted text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_account_id is null
    or p_device_id is null
    or char_length(p_device_id) not between 1 and 160
    or p_device_id !~ '^[A-Za-z0-9._:-]+$'
    or p_secret_encrypted is null
    or p_secret_encrypted not like 'enc:v2:%'
    or char_length(p_secret_encrypted) not between 64 and 4096 then
    raise exception using errcode = '22023', message = 'invalid vision device identity';
  end if;

  insert into runtime.vision_device_identities (
    account_id, device_id, secret_encrypted, status, revoked_at
  ) values (
    p_account_id, p_device_id, p_secret_encrypted, 'active', null
  )
  on conflict (device_id) do update
    set secret_encrypted = excluded.secret_encrypted,
        status = 'active',
        revoked_at = null,
        updated_at = clock_timestamp()
    where runtime.vision_device_identities.account_id = excluded.account_id
  returning id into v_id;

  if v_id is null then
    raise exception using errcode = '23505', message = 'vision device identity conflict';
  end if;

  return jsonb_build_object('device_identity_id', v_id, 'status', 'active');
end
$$;

create function public.runtime_resolve_vision_device_identity(p_device_id text)
returns table (account_id uuid, device_id text, secret_encrypted text)
language sql
stable
security definer
set search_path = ''
as $$
  select identity.account_id, identity.device_id, identity.secret_encrypted
  from runtime.vision_device_identities as identity
  where identity.device_id = p_device_id
    and identity.status = 'active'
  limit 1
$$;

revoke all on function public.runtime_configure_vision_device_identity(uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.runtime_resolve_vision_device_identity(text)
  from public, anon, authenticated;
grant execute on function public.runtime_configure_vision_device_identity(uuid, text, text)
  to service_role;
grant execute on function public.runtime_resolve_vision_device_identity(text)
  to service_role;

comment on table runtime.vision_device_identities is
  'ADR 002 camera identities. HMAC keys are AES-GCM ciphertext bound to account and device AAD.';

-- ─── 20260825020000_runtime_live_gate.sql ────────────────────────────────────────────────────
-- ADR 002 Stage 4: evidence-backed evaluation summaries and a fail-closed live policy gate.
-- Outbox actions are intentionally NOT created here: runtime_enqueue_outbox_action binds the exact
-- approved action hash in the next step. This function only records the canonical policy decision.

create table runtime.vision_eval_summaries (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  workflow_type text not null,
  dataset_hash text not null,
  sample_count integer not null,
  precision_score numeric(8,7) not null,
  recall_score numeric(8,7) not null,
  false_action_rate numeric(8,7) not null,
  average_grounding_score numeric(8,7) not null,
  passed boolean not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint vision_eval_summary_account_id_id_key unique (account_id, id),
  constraint vision_eval_summary_workflow_type check (
    char_length(workflow_type) between 1 and 128
    and workflow_type ~ '^[a-z][a-z0-9_]{0,127}$'
  ),
  constraint vision_eval_summary_dataset_hash check (dataset_hash ~ '^[0-9a-f]{64}$'),
  constraint vision_eval_summary_sample_count check (sample_count between 1 and 10000000),
  constraint vision_eval_summary_metric_bounds check (
    precision_score between 0 and 1
    and recall_score between 0 and 1
    and false_action_rate between 0 and 1
    and average_grounding_score between 0 and 1
  ),
  constraint vision_eval_summary_pass_invariant check (
    passed = (
      sample_count >= 100
      and precision_score >= 0.95
      and false_action_rate <= 0.01
      and average_grounding_score >= 0.95
    )
  )
);

create index vision_eval_summaries_latest_idx
  on runtime.vision_eval_summaries (account_id, workflow_type, created_at desc, id desc);

create trigger vision_eval_summaries_immutable
before update or delete on runtime.vision_eval_summaries
for each row execute function runtime.prevent_mutation();

create table runtime.live_gate_evaluations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  eval_summary_id uuid,
  policy_decision_id uuid not null,
  approval_request_id uuid,
  confidence_score numeric(8,7) not null,
  threshold numeric(8,7) not null,
  decision text not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint live_gate_evaluations_account_id_id_key unique (account_id, id),
  constraint live_gate_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint live_gate_eval_summary_fkey foreign key (account_id, eval_summary_id)
    references runtime.vision_eval_summaries(account_id, id) on delete restrict,
  constraint live_gate_policy_fkey foreign key (account_id, workflow_id, policy_decision_id)
    references runtime.policy_decisions(account_id, workflow_id, id) on delete restrict,
  constraint live_gate_approval_fkey foreign key (account_id, workflow_id, approval_request_id)
    references public.approval_requests(account_id, workflow_id, id) on delete restrict,
  constraint live_gate_scores check (
    confidence_score between 0 and 1 and threshold between 0.95 and 1
  ),
  constraint live_gate_decision check (decision in ('allow', 'require_approval')),
  constraint live_gate_approval_consistency check (
    (decision = 'allow' and approval_request_id is null and eval_summary_id is not null)
    or (decision = 'require_approval' and approval_request_id is not null)
  )
);

create trigger live_gate_evaluations_immutable
before update or delete on runtime.live_gate_evaluations
for each row execute function runtime.prevent_mutation();

create function public.runtime_record_vision_eval_summary(
  p_account_id uuid,
  p_workflow_type text,
  p_precision_score numeric,
  p_recall_score numeric,
  p_false_action_rate numeric,
  p_sample_count integer,
  p_dataset_hash text,
  p_average_grounding_score numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_passed boolean;
begin
  if p_account_id is null
    or p_workflow_type is null
    or p_workflow_type !~ '^[a-z][a-z0-9_]{0,127}$'
    or p_dataset_hash is null or p_dataset_hash !~ '^[0-9a-f]{64}$'
    or p_sample_count not between 1 and 10000000
    or p_precision_score not between 0 and 1
    or p_recall_score not between 0 and 1
    or p_false_action_rate not between 0 and 1
    or p_average_grounding_score not between 0 and 1 then
    raise exception using errcode = '22023', message = 'invalid vision evaluation summary';
  end if;

  v_passed := p_sample_count >= 100
    and p_precision_score >= 0.95
    and p_false_action_rate <= 0.01
    and p_average_grounding_score >= 0.95;

  insert into runtime.vision_eval_summaries (
    account_id, workflow_type, dataset_hash, sample_count,
    precision_score, recall_score, false_action_rate, average_grounding_score, passed
  ) values (
    p_account_id, p_workflow_type, p_dataset_hash, p_sample_count,
    p_precision_score, p_recall_score, p_false_action_rate, p_average_grounding_score, v_passed
  ) returning id into v_id;

  return jsonb_build_object('eval_summary_id', v_id, 'passed', v_passed);
end
$$;

create function public.runtime_evaluate_live_gate(
  p_account_id uuid,
  p_workflow_id uuid,
  p_confidence_score numeric,
  p_threshold numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_eval runtime.vision_eval_summaries%rowtype;
  v_action jsonb;
  v_policy jsonb;
  v_decision text;
  v_reasons jsonb;
  v_gate_id uuid;
begin
  if p_confidence_score is null or p_confidence_score not between 0 and 1
    or p_threshold is null or p_threshold not between 0.95 and 1 then
    raise exception using errcode = '22023', message = 'invalid live gate score';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.execution_mode <> 'live' then
    raise exception using errcode = '55000', message = 'shadow workflow cannot enter live gate';
  end if;
  if v_run.current_state <> 'waiting_for_policy' then
    raise exception using errcode = '55000', message = 'workflow is not waiting for live policy';
  end if;

  v_action := v_run.context -> 'proposed_action';
  if v_action is null or jsonb_typeof(v_action) <> 'object'
    or v_action = '{}'::jsonb or octet_length(v_action::text) > 65536 then
    raise exception using errcode = '22023', message = 'live gate requires a bounded proposed action';
  end if;

  select summary.* into v_eval
  from runtime.vision_eval_summaries as summary
  where summary.account_id = p_account_id
    and summary.workflow_type = v_run.workflow_type
    and summary.passed = true
    and summary.created_at >= clock_timestamp() - interval '30 days'
  order by summary.created_at desc, summary.id desc
  limit 1;

  if p_confidence_score >= p_threshold and v_eval.id is not null then
    v_decision := 'allow';
    v_reasons := jsonb_build_array('CONFIDENCE_THRESHOLD_MET', 'PRECISION_EVAL_PASSED');
  else
    v_decision := 'require_approval';
    v_reasons := jsonb_build_array(
      case when p_confidence_score < p_threshold
        then 'CONFIDENCE_BELOW_THRESHOLD' else 'PRECISION_EVAL_NOT_PASSED' end
    );
  end if;

  v_policy := public.runtime_record_policy_decision(
    p_account_id => p_account_id,
    p_workflow_id => p_workflow_id,
    p_ruleset_id => 'adr002_live_gate',
    p_policy_version => 'adr002-stage4-v1',
    p_decision => v_decision,
    p_reasons => v_reasons,
    p_policy_input => jsonb_build_object(
      'confidence_score', p_confidence_score,
      'threshold', p_threshold,
      'eval_summary_id', v_eval.id,
      'eval_passed', coalesce(v_eval.passed, false)
    ),
    p_action_payload => v_action,
    p_actor_id => 'runtime-live-gate',
    p_evidence_ref => case when v_eval.id is null then null else 'vision-eval:' || v_eval.id::text end,
    p_approval_summary => left(
      coalesce(v_run.context ->> 'approval_summary', 'Vision action requires human approval'),
      240
    )
  );

  insert into runtime.live_gate_evaluations (
    account_id, workflow_id, eval_summary_id, policy_decision_id, approval_request_id,
    confidence_score, threshold, decision
  ) values (
    p_account_id, p_workflow_id, v_eval.id,
    (v_policy ->> 'policy_decision_id')::uuid,
    nullif(v_policy ->> 'approval_request_id', '')::uuid,
    p_confidence_score, p_threshold, v_decision
  ) returning id into v_gate_id;

  return v_policy || jsonb_build_object(
    'live_gate_evaluation_id', v_gate_id,
    'live_gate_decision', v_decision,
    'eval_summary_id', v_eval.id,
    -- Existing ADR 001 terminology: state is waiting_for_action; the next exact-hash Outbox action
    -- may now be enqueued. A workflow queued transition here would bypass the action lifecycle.
    'outbox_eligibility', case when v_decision = 'allow' then 'queued' else 'blocked' end
  );
end
$$;

revoke all on table runtime.vision_eval_summaries from public, anon, authenticated;
revoke all on table runtime.live_gate_evaluations from public, anon, authenticated;
revoke all on function public.runtime_record_vision_eval_summary(
  uuid, text, numeric, numeric, numeric, integer, text, numeric
) from public, anon, authenticated;
revoke all on function public.runtime_evaluate_live_gate(uuid, uuid, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.runtime_record_vision_eval_summary(
  uuid, text, numeric, numeric, numeric, integer, text, numeric
) to service_role;
grant execute on function public.runtime_evaluate_live_gate(uuid, uuid, numeric, numeric)
  to service_role;

comment on function public.runtime_evaluate_live_gate(uuid, uuid, numeric, numeric) is
  'Fail-closed ADR 002 gate. Uses the canonical Policy/Approval path and never upgrades shadow rows.';

-- ─── 20260825030000_dashboard_telemetry_and_approvals.sql ────────────────────────────────────
-- ADR 001/002 operational dashboard: service-only, tenant-scoped telemetry and HITL decisions.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'runtime-artifacts',
  'runtime-artifacts',
  false,
  1073741824,
  array['application/pdf', 'text/html', 'image/jpeg', 'video/mp4', 'video/webm']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create function public.runtime_dashboard_metrics(p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inbox_total bigint;
  v_outbox_delivered bigint;
  v_dead_letter_count bigint;
  v_orphaned_inbox bigint;
  v_eval runtime.vision_eval_summaries%rowtype;
  v_f1 numeric := 0;
  v_gate_status text := 'no_data';
  v_uptime_seconds bigint;
begin
  if p_account_id is null or not exists (
    select 1 from public.accounts as account where account.id = p_account_id
  ) then
    raise exception using errcode = '22023', message = 'invalid dashboard account';
  end if;

  select count(*) into v_inbox_total
  from runtime.inbox_events as inbox where inbox.account_id = p_account_id;

  select count(*) into v_outbox_delivered
  from runtime.outbox_actions as action
  where action.account_id = p_account_id
    and action.execution_mode = 'live'
    and action.status = 'completed';

  select
    (select count(*) from runtime.workflow_runs as run
      where run.account_id = p_account_id and run.current_state = 'dead_letter')
    + (select count(*) from runtime.outbox_actions as action
      where action.account_id = p_account_id and action.status = 'dead_letter')
    + (select count(*) from runtime.compute_jobs as job
      where job.account_id = p_account_id and job.status = 'dead_letter')
  into v_dead_letter_count;

  select count(*) into v_orphaned_inbox
  from runtime.inbox_events as inbox
  where inbox.account_id = p_account_id
    and not exists (
      select 1 from runtime.workflow_runs as run
      where run.account_id = inbox.account_id and run.inbox_event_id = inbox.id
    );

  select summary.* into v_eval
  from runtime.vision_eval_summaries as summary
  where summary.account_id = p_account_id
  order by summary.created_at desc, summary.id desc
  limit 1;

  if v_eval.id is not null then
    if v_eval.precision_score + v_eval.recall_score > 0 then
      v_f1 := 2 * v_eval.precision_score * v_eval.recall_score
        / (v_eval.precision_score + v_eval.recall_score);
    end if;
    v_gate_status := case
      when v_eval.created_at < clock_timestamp() - interval '30 days' then 'stale'
      when v_eval.passed then 'eligible'
      else 'blocked'
    end;
  end if;

  v_uptime_seconds := greatest(
    0,
    floor(extract(epoch from clock_timestamp() - pg_catalog.pg_postmaster_start_time()))::bigint
  );

  return pg_catalog.jsonb_build_object(
    'inbox_total', v_inbox_total,
    'outbox_delivered', v_outbox_delivered,
    'dead_letter_count', v_dead_letter_count,
    'live_gate_status', v_gate_status,
    'avg_grounding_score', coalesce(v_eval.average_grounding_score, 0),
    'f1_score', round(v_f1, 7),
    'false_action_rate', coalesce(v_eval.false_action_rate, 0),
    'uptime_seconds', v_uptime_seconds,
    'zero_data_loss', v_orphaned_inbox = 0,
    'orphaned_inbox_count', v_orphaned_inbox,
    'eval_created_at', v_eval.created_at
  );
end
$$;

create function public.runtime_dashboard_list_approvals(
  p_account_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid dashboard approval limit';
  end if;

  select coalesce(pg_catalog.jsonb_agg(item.payload order by item.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select request.created_at, pg_catalog.jsonb_build_object(
      'id', request.id,
      'workflow_id', request.workflow_id,
      'action_type', request.action_type,
      'summary', request.summary,
      'status', request.status,
      'expires_at', request.expires_at,
      'created_at', request.created_at,
      'workflow_type', run.workflow_type,
      'execution_mode', run.execution_mode,
      'sensor_metadata', coalesce(
        run.context -> 'untrusted_sensor_output',
        run.context -> 'sensor_metadata',
        '{}'::jsonb
      ),
      'artifact_manifests', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'job_id', job.id,
            'profile', job.profile,
            'result_manifest', job.result_manifest - 'stdout_sanitized' - 'stderr_sanitized'
          ) order by job.created_at, job.id
        )
        from (
          select candidate.*
          from runtime.compute_jobs as candidate
          where candidate.account_id = request.account_id
            and candidate.workflow_id = request.workflow_id
            and candidate.status = 'completed'
            and candidate.result_manifest is not null
          order by candidate.created_at, candidate.id
          limit 64
        ) as job
      ), '[]'::jsonb)
    ) as payload
    from public.approval_requests as request
    join runtime.workflow_runs as run
      on run.account_id = request.account_id and run.id = request.workflow_id
    where request.account_id = p_account_id
      and request.status = 'pending'
      and request.expires_at > clock_timestamp()
      and run.current_state = 'waiting_for_approval'
      and run.execution_mode = 'live'
    order by request.created_at desc
    limit p_limit
  ) as item;

  return v_result;
end
$$;

create function public.runtime_dashboard_decide_approval(
  p_account_id uuid,
  p_approval_request_id uuid,
  p_user_id uuid,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.approval_requests%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_policy runtime.policy_decisions%rowtype;
  v_seq bigint;
  v_transition_id uuid;
  v_payload jsonb;
  v_connector_id text;
  v_action_type text;
  v_result jsonb;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception using errcode = '22023', message = 'invalid dashboard approval decision';
  end if;
  if p_reason is not null and char_length(p_reason) > 500 then
    raise exception using errcode = '22023', message = 'approval reason exceeds limit';
  end if;
  if not exists (
    select 1 from public.users as app_user
    where app_user.id = p_user_id
      and app_user.account_id = p_account_id
      and (app_user.role in ('owner', 'operator') or app_user.is_admin)
  ) then
    raise exception using errcode = '42501', message = 'invalid dashboard operator context';
  end if;

  select request.* into strict v_request
  from public.approval_requests as request
  where request.account_id = p_account_id and request.id = p_approval_request_id
  for update;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = v_request.workflow_id
  for update;

  if v_request.status <> 'pending'
    or v_request.expires_at <= clock_timestamp()
    or v_run.current_state <> 'waiting_for_approval'
    or v_run.execution_mode <> 'live' then
    raise exception using errcode = '55000', message = 'approval request is not pending';
  end if;

  if p_decision = 'approve' then
    v_payload := v_run.context -> 'proposed_action';
    v_connector_id := coalesce(
      nullif(v_run.context ->> 'proposed_connector_id', ''),
      nullif(v_payload ->> 'connector_id', ''),
      nullif(v_payload ->> 'channel', '')
    );
    v_action_type := coalesce(
      nullif(v_run.context ->> 'proposed_action_type', ''),
      nullif(v_payload ->> 'action_type', ''),
      nullif(v_payload ->> 'action', '')
    );
    if v_payload is null or pg_catalog.jsonb_typeof(v_payload) <> 'object'
      or v_connector_id is null or char_length(v_connector_id) > 160
      or v_action_type is null or char_length(v_action_type) > 128 then
      raise exception using errcode = '22023', message = 'approval action metadata is invalid';
    end if;

    v_result := public.runtime_resolve_approval_and_enqueue_action(
      p_account_id => p_account_id,
      p_workflow_id => v_run.id,
      p_approval_request_id => v_request.id,
      p_user_id => p_user_id,
      p_decision => 'approved',
      p_connector_id => v_connector_id,
      p_action_type => v_action_type,
      p_payload => v_payload,
      p_idempotency_key => 'dashboard-approval:' || v_request.id::text,
      p_max_attempts => 5
    );
    return v_result || pg_catalog.jsonb_build_object(
      'decision', 'approve', 'state', 'waiting_for_action'
    );
  end if;

  select decision.* into strict v_policy
  from runtime.policy_decisions as decision
  where decision.account_id = p_account_id
    and decision.workflow_id = v_run.id
    and decision.id = v_request.policy_decision_id;

  select coalesce(max(transition.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as transition
  where transition.account_id = p_account_id and transition.workflow_id = v_run.id;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, policy_version, lease_epoch, transition_payload
  ) values (
    p_account_id, v_run.id, v_seq, 'waiting_for_approval', 'cancelled',
    'cancelled', 'user', p_user_id::text, v_run.correlation_id,
    v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
    pg_catalog.jsonb_build_object(
      'approval_request_id', v_request.id,
      'reason', nullif(left(coalesce(p_reason, ''), 500), '')
    )
  ) returning id into v_transition_id;

  update public.approval_requests
  set status = 'rejected', decided_by = p_user_id, decided_at = clock_timestamp()
  where account_id = p_account_id and id = v_request.id;

  update runtime.outbox_actions
  set status = 'cancelled', completed_at = clock_timestamp(),
      next_attempt_at = null, claimed_at = null, lease_until = null, claim_token = null,
      last_error_code = 'APPROVAL_REJECTED', updated_at = clock_timestamp()
  where account_id = p_account_id
    and workflow_id = v_run.id
    and approval_request_id = v_request.id
    and status in ('pending', 'retry_scheduled');

  update runtime.workflow_runs
  set current_state = 'cancelled', terminal_reason_code = 'APPROVAL_REJECTED',
      terminal_at = clock_timestamp(), updated_at = clock_timestamp()
  where account_id = p_account_id and id = v_run.id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    event_type, actor_type, actor_id, correlation_id, details,
    runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, v_run.id, v_transition_id, v_policy.id, v_request.id,
    'runtime.dashboard_approval_rejected', 'user', p_user_id::text, v_run.correlation_id,
    pg_catalog.jsonb_build_object('decision', 'reject', 'reason', nullif(left(coalesce(p_reason, ''), 500), '')),
    'runtime-v1', v_run.workflow_version, v_policy.policy_version
  );

  return pg_catalog.jsonb_build_object(
    'decision', 'reject', 'workflow_id', v_run.id, 'state', 'cancelled'
  );
end
$$;

create function public.runtime_dashboard_workflow_trace(
  p_account_id uuid,
  p_workflow_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
begin
  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id;

  return pg_catalog.jsonb_build_object(
    'workflow', pg_catalog.jsonb_build_object(
      'id', v_run.id,
      'workflow_type', v_run.workflow_type,
      'workflow_version', v_run.workflow_version,
      'execution_mode', v_run.execution_mode,
      'current_state', v_run.current_state,
      'attempt_count', v_run.attempt_count,
      'created_at', v_run.created_at,
      'updated_at', v_run.updated_at,
      'terminal_at', v_run.terminal_at,
      'terminal_reason_code', v_run.terminal_reason_code
    ),
    'transitions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', timeline.id,
        'sequence', timeline.transition_seq,
        'from_state', timeline.from_state,
        'to_state', timeline.to_state,
        'transition_type', timeline.transition_type,
        'actor_type', timeline.actor_type,
        'created_at', timeline.created_at,
        'phase_duration_ms', greatest(0, floor(extract(epoch from
          timeline.created_at - coalesce(timeline.previous_at, v_run.created_at)) * 1000))::bigint
      ) order by timeline.transition_seq)
      from (
        select transition.*,
          lag(transition.created_at) over (order by transition.transition_seq) as previous_at
        from runtime.workflow_transitions as transition
        where transition.account_id = p_account_id and transition.workflow_id = p_workflow_id
      ) as timeline
    ), '[]'::jsonb),
    'compute_jobs', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', job.id,
        'profile', job.profile,
        'status', job.status,
        'attempt_count', job.attempt_count,
        'duration_ms', greatest(0, floor(extract(epoch from job.updated_at - job.created_at) * 1000))::bigint,
        'error_code', job.error_code,
        'result_manifest', case when job.result_manifest is null then null
          else job.result_manifest - 'stdout_sanitized' - 'stderr_sanitized' end,
        'created_at', job.created_at,
        'updated_at', job.updated_at
      ) order by job.created_at, job.id)
      from runtime.compute_jobs as job
      where job.account_id = p_account_id and job.workflow_id = p_workflow_id
    ), '[]'::jsonb),
    'outbox_actions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', action.id,
        'connector_id', action.connector_id,
        'action_type', action.action_type,
        'execution_mode', action.execution_mode,
        'status', action.status,
        'attempt_count', action.attempt_count,
        'created_at', action.created_at,
        'completed_at', action.completed_at,
        'error_code', action.last_error_code
      ) order by action.created_at, action.id)
      from runtime.outbox_actions as action
      where action.account_id = p_account_id and action.workflow_id = p_workflow_id
    ), '[]'::jsonb),
    'self_healing_iterations', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', audit.id,
        'created_at', audit.created_at,
        'details', audit.details
      ) order by audit.created_at, audit.id)
      from runtime.audit_events as audit
      where audit.account_id = p_account_id
        and audit.workflow_id = p_workflow_id
        and audit.event_type = 'runtime.self_healing_iteration'
    ), '[]'::jsonb)
  );
end
$$;

revoke all on function public.runtime_dashboard_metrics(uuid) from public, anon, authenticated;
revoke all on function public.runtime_dashboard_list_approvals(uuid, integer) from public, anon, authenticated;
revoke all on function public.runtime_dashboard_decide_approval(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.runtime_dashboard_workflow_trace(uuid, uuid) from public, anon, authenticated;
grant execute on function public.runtime_dashboard_metrics(uuid) to service_role;
grant execute on function public.runtime_dashboard_list_approvals(uuid, integer) to service_role;
grant execute on function public.runtime_dashboard_decide_approval(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.runtime_dashboard_workflow_trace(uuid, uuid) to service_role;

comment on function public.runtime_dashboard_decide_approval(uuid, uuid, uuid, text, text) is
  'Tenant-scoped HITL decision. Approval uses the canonical payload-hash resolver; rejection cancels atomically.';

-- ─── 20260826090000_billing_usage_metering.sql ───────────────────────────────────────────────
-- ADR 003: usage metering, FEFO reservations and append-only ledger.
-- Closed schema: every table is unreachable except through the security-definer RPCs below.

create schema billing;
revoke all on schema billing from public, anon, authenticated;
grant usage on schema billing to service_role;

-- ---------------------------------------------------------------------------------------------
-- billing.pricing_matrices
-- ---------------------------------------------------------------------------------------------

create table billing.pricing_matrices (
  id uuid primary key default gen_random_uuid(),
  version integer not null,
  name text not null,
  conversion_rules jsonb not null default '{}'::jsonb,
  effective_from timestamptz not null default clock_timestamp(),
  effective_until timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint pricing_matrices_version_key unique (version),
  constraint pricing_matrices_account_id_id_key unique (id),
  constraint pricing_matrices_version_check check (version > 0),
  constraint pricing_matrices_name_check check (char_length(name) between 1 and 160),
  constraint pricing_matrices_rules_type_check check (jsonb_typeof(conversion_rules) = 'object'),
  -- 32 KiB bound: these payloads are small structured rule sets, not agent output; see ADR 003 §3.7.
  constraint pricing_matrices_rules_size_check check (octet_length(conversion_rules::text) <= 32768),
  constraint pricing_matrices_window_check check (
    effective_until is null or effective_until > effective_from
  )
);

-- Only one active matrix at a time: admission always snapshots exactly one unambiguous version.
create unique index pricing_matrices_single_active_idx
  on billing.pricing_matrices ((true))
  where is_active;

revoke all on billing.pricing_matrices from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.account_usage_policies
-- ---------------------------------------------------------------------------------------------

create table billing.account_usage_policies (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  pricing_matrix_version integer not null references billing.pricing_matrices (version),
  budget_units bigint not null,
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint account_usage_policies_account_key unique (account_id),
  constraint account_usage_policies_account_id_id_key unique (account_id, id),
  constraint account_usage_policies_budget_check check (budget_units > 0),
  constraint account_usage_policies_policy_type_check check (jsonb_typeof(policy) = 'object'),
  constraint account_usage_policies_policy_size_check check (octet_length(policy::text) <= 32768)
);

revoke all on billing.account_usage_policies from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.usage_buckets — FEFO-consumed purchased/granted compute-unit buckets
-- ---------------------------------------------------------------------------------------------

create table billing.usage_buckets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  source text not null,
  pricing_matrix_version integer not null references billing.pricing_matrices (version),
  total_units bigint not null,
  remaining_units bigint not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_buckets_account_id_id_key unique (account_id, id),
  constraint usage_buckets_source_check check (
    source in ('purchase', 'grant', 'promo', 'legacy_migration')
  ),
  constraint usage_buckets_total_check check (total_units > 0),
  constraint usage_buckets_remaining_check check (
    remaining_units >= 0 and remaining_units <= total_units
  )
);

create index usage_buckets_fefo_idx
  on billing.usage_buckets (account_id, expires_at, id)
  where remaining_units > 0;

revoke all on billing.usage_buckets from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.usage_reservations
-- ---------------------------------------------------------------------------------------------

create table billing.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  idempotency_key text not null,
  claim_token uuid not null default gen_random_uuid(),
  lease_epoch bigint not null default 0,
  owner_token text not null,
  status text not null default 'reserved',
  reserved_units bigint not null,
  actual_units bigint,
  policy_snapshot jsonb not null default '{}'::jsonb,
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  released_at timestamptz,
  constraint usage_reservations_account_id_id_key unique (account_id, id),
  constraint usage_reservations_idempotency_key unique (account_id, idempotency_key),
  constraint usage_reservations_status_check check (
    status in ('reserved', 'finalized', 'released', 'expired')
  ),
  constraint usage_reservations_idempotency_shape_check check (
    char_length(idempotency_key) between 1 and 200
  ),
  constraint usage_reservations_owner_token_check check (
    char_length(owner_token) between 1 and 200
  ),
  constraint usage_reservations_reserved_check check (reserved_units > 0),
  constraint usage_reservations_actual_check check (
    actual_units is null or (actual_units >= 0 and actual_units <= reserved_units)
  ),
  constraint usage_reservations_lease_epoch_check check (lease_epoch >= 0),
  constraint usage_reservations_snapshot_type_check check (
    jsonb_typeof(policy_snapshot) = 'object'
  ),
  constraint usage_reservations_snapshot_size_check check (
    octet_length(policy_snapshot::text) <= 32768
  ),
  constraint usage_reservations_result_type_check check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint usage_reservations_result_size_check check (
    result is null or octet_length(result::text) <= 32768
  ),
  constraint usage_reservations_terminal_check check (
    (status = 'reserved' and finalized_at is null and released_at is null)
    or (status = 'finalized' and finalized_at is not null)
    or (status in ('released', 'expired') and released_at is not null)
  )
);

create index usage_reservations_expiry_idx
  on billing.usage_reservations (account_id, expires_at, id)
  where status = 'reserved';

revoke all on billing.usage_reservations from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.usage_reservation_allocations — one reservation, FEFO-split across many buckets
-- ---------------------------------------------------------------------------------------------

create table billing.usage_reservation_allocations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  reservation_id uuid not null,
  bucket_id uuid not null,
  allocated_units bigint not null,
  refunded_units bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_reservation_allocations_account_id_id_key unique (account_id, id),
  constraint usage_reservation_allocations_reservation_fkey
    foreign key (account_id, reservation_id)
    references billing.usage_reservations (account_id, id) on delete cascade,
  constraint usage_reservation_allocations_bucket_fkey
    foreign key (account_id, bucket_id)
    references billing.usage_buckets (account_id, id) on delete restrict,
  constraint usage_reservation_allocations_units_check check (allocated_units > 0),
  constraint usage_reservation_allocations_refund_check check (
    refunded_units >= 0 and refunded_units <= allocated_units
  )
);

create index usage_reservation_allocations_reservation_idx
  on billing.usage_reservation_allocations (account_id, reservation_id);
create index usage_reservation_allocations_bucket_idx
  on billing.usage_reservation_allocations (account_id, bucket_id);

revoke all on billing.usage_reservation_allocations from public, anon, authenticated;

-- The parent-sum invariant ("reserved_units = sum(allocations.allocated_units)") is cross-row and
-- cannot be a CHECK constraint (see ADR 003 §3.5). reserve_usage always inserts a reservation's
-- full allocation set in a single multi-row INSERT, so a statement-level trigger reading the
-- transition table sees the complete set exactly once per reservation.
create function billing.check_allocation_sum()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_expected bigint;
begin
  for r in
    select new_rows.reservation_id as reservation_id, sum(new_rows.allocated_units) as total
    from new_rows
    group by new_rows.reservation_id
  loop
    select reservation.reserved_units into strict v_expected
    from billing.usage_reservations as reservation
    where reservation.id = r.reservation_id;
    if r.total is distinct from v_expected then
      raise exception using errcode = '0LU02',
        message = 'allocation sum does not match reservation.reserved_units';
    end if;
  end loop;
  return null;
end
$$;

create trigger usage_reservation_allocations_sum_check
  after insert on billing.usage_reservation_allocations
  referencing new table as new_rows
  for each statement
  execute function billing.check_allocation_sum();

-- ---------------------------------------------------------------------------------------------
-- billing.usage_ledger — append-only audit trail
-- ---------------------------------------------------------------------------------------------

create table billing.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  event_type text not null,
  units bigint not null,
  reservation_id uuid,
  bucket_id uuid,
  idempotency_key text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_ledger_event_type_check check (
    event_type in ('reserve', 'finalize', 'refund', 'release', 'expire', 'grant')
  ),
  -- >= 0, not > 0: a finalize event may legitimately record zero actual units (fully refunded).
  constraint usage_ledger_units_check check (units >= 0),
  constraint usage_ledger_details_type_check check (jsonb_typeof(details) = 'object'),
  constraint usage_ledger_details_size_check check (octet_length(details::text) <= 32768),
  constraint usage_ledger_reservation_fkey
    foreign key (account_id, reservation_id)
    references billing.usage_reservations (account_id, id) on delete restrict,
  constraint usage_ledger_bucket_fkey
    foreign key (account_id, bucket_id)
    references billing.usage_buckets (account_id, id) on delete restrict
);

create index usage_ledger_account_idx on billing.usage_ledger (account_id, created_at, id);
create index usage_ledger_reservation_idx on billing.usage_ledger (account_id, reservation_id);

revoke all on billing.usage_ledger from public, anon, authenticated;

create function billing.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '0LU01', message = 'usage_ledger is append-only';
end
$$;

create trigger usage_ledger_immutable
  before update or delete on billing.usage_ledger
  for each row execute function billing.prevent_ledger_mutation();

-- ---------------------------------------------------------------------------------------------
-- billing.cutover_state — GLOBAL, one-way admission gate. Neither billing.reserve_usage nor the
-- patched public.reserve_token_usage may ever both admit the same unit of work: before activation
-- only legacy admits (v2_active = false), after a successful billing.activate_global_cutover only
-- v2 admits. This is deliberately a single singleton row, not a per-account flag — a per-account
-- cutover would let two admission routes both be "correct" for different accounts at once, which is
-- exactly the dual-admission risk this table exists to close off. See ADR 003 §5.
-- ---------------------------------------------------------------------------------------------

create table billing.cutover_state (
  singleton boolean primary key default true,
  v2_active boolean not null default false,
  activated_by text,
  reason_code text,
  activated_at timestamptz,
  cutover_epoch bigint not null default 0,
  constraint cutover_state_singleton_check check (singleton),
  constraint cutover_state_epoch_check check (cutover_epoch >= 0),
  constraint cutover_state_activation_check check (
    (not v2_active and activated_by is null and reason_code is null and activated_at is null)
    or (v2_active and activated_by is not null and reason_code is not null and activated_at is not null)
  ),
  constraint cutover_state_reason_check check (
    reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint cutover_state_actor_check check (
    activated_by is null or char_length(activated_by) between 1 and 160
  )
);

insert into billing.cutover_state (singleton) values (true);

revoke all on billing.cutover_state from public, anon, authenticated;

comment on table billing.cutover_state is
  'Global, one-way v2 admission gate. Never per-account: exactly one of legacy/v2 may admit at a time.';

comment on table billing.pricing_matrices is
  'Versioned pricing/unit-conversion rules. Admission always snapshots a specific version.';
comment on table billing.account_usage_policies is
  'Per-account budget referencing a pricing_matrices version by value, not a live pointer.';
comment on table billing.usage_buckets is
  'Purchased/granted compute-unit capacity, FEFO-consumed by expires_at.';
comment on table billing.usage_reservations is
  'Fenced reservations: claim_token + lease_epoch gate every state transition.';
comment on table billing.usage_reservation_allocations is
  'FEFO split of one reservation across one or more buckets.';
comment on table billing.usage_ledger is
  'Append-only event trail; mutation is blocked by trigger, not just convention.';

-- ─── 20260826093000_billing_reservation_rpcs.sql ─────────────────────────────────────────────
-- ADR 003: billing.* reservation RPCs — fail-closed admission, FEFO allocation, fenced lifecycle.

create function billing.reserve_usage(
  p_account_id uuid,
  p_idempotency_key text,
  p_units bigint,
  p_owner_token text,
  p_ttl_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_cutover billing.cutover_state%rowtype;
  v_legacy public.token_usage_reservations%rowtype;
  v_existing billing.usage_reservations%rowtype;
  v_policy billing.account_usage_policies%rowtype;
  v_matrix billing.pricing_matrices%rowtype;
  v_outstanding bigint;
  v_bucket record;
  v_remaining_needed bigint;
  v_take bigint;
  v_reservation_id uuid := gen_random_uuid();
  v_claim_token uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_allocations jsonb := '[]'::jsonb;
  v_bucket_ids uuid[] := '{}';
  v_alloc_units bigint[] := '{}';
  v_result jsonb;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'invalid account id';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;
  if p_units is null or p_units <= 0 then
    raise exception using errcode = '22023', message = 'invalid reservation units';
  end if;
  if p_owner_token is null or char_length(p_owner_token) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid owner token';
  end if;
  if p_ttl_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid reservation ttl';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then
    return jsonb_build_object('status', 'denied_kill_switch');
  end if;

  -- Global cutover gate (ADR 003 §5): v2 admits nothing until billing.activate_global_cutover has
  -- run. This is the mirror image of the cutover check patched into public.reserve_token_usage, so
  -- exactly one of the two routes ever admits for a given moment in time.
  select cutover.* into strict v_cutover
  from billing.cutover_state as cutover
  where cutover.singleton
  for share;
  if not v_cutover.v2_active then
    return jsonb_build_object('status', 'denied_cutover_inactive');
  end if;

  -- Lock this account's policy row FIRST, before the idempotency lookup and the outstanding-budget
  -- calculation, so that all concurrent reserve_usage calls for the same account serialize on this
  -- one lock. That serialization is what makes the idempotency lookup below race-free (a concurrent
  -- caller with the same idempotency_key can no longer race the INSERT — it queues behind this lock
  -- and then sees the first caller's committed row) and what makes the budget check exact (no two
  -- concurrent callers can read the same "outstanding" total and both admit past budget_units).
  select policy.* into v_policy
  from billing.account_usage_policies as policy
  where policy.account_id = p_account_id
  for update;
  if not found then
    return jsonb_build_object('status', 'denied_no_policy');
  end if;

  -- Cross-scheme idempotency at cutover (ADR 003 §5): p_idempotency_key and the legacy
  -- public.token_usage_reservations.billing_key share the same caller-chosen key space, so a
  -- legacy reservation finalized before cutover and retried with the same key after cutover must
  -- not be silently re-admitted and re-charged by v2. The policy lock above already serializes
  -- same-account callers, so this lookup is race-free against a concurrent legacy writer too.
  select legacy.* into v_legacy
  from public.token_usage_reservations as legacy
  where legacy.account_id = p_account_id and legacy.billing_key = p_idempotency_key
  for update;
  if found then
    if v_legacy.status = 'finalized' then
      return jsonb_build_object(
        'status', 'legacy_finalized',
        'idempotent_replay', true,
        'legacy_result', v_legacy.result
      );
    elsif v_legacy.status = 'active' then
      -- An active legacy reservation after cutover means the legacy admission route raced (or was
      -- bypassed) past the point where it should have been denied by the cutover gate. Fail closed
      -- rather than risk double-admitting the same logical work.
      return jsonb_build_object('status', 'denied_legacy_active');
    end if;
    -- released/expired: the legacy reservation consumed no lasting balance (it was refunded or
    -- swept without ever finalizing), so admitting a fresh v2 reservation under the same key is
    -- correct — fall through to the v2 idempotency lookup below.
  end if;

  -- Tenant-scoped idempotency: any prior result for this key wins, regardless of its status. Safe
  -- from unique_violation races now because the policy lock above already serializes same-account
  -- callers — a second call with the same key can only reach this SELECT after the first call's
  -- INSERT has committed (or the first call is still holding the policy lock ahead of it).
  select reservation.* into v_existing
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id
    and reservation.idempotency_key = p_idempotency_key
  for update;
  if found then
    return jsonb_build_object(
      'status', case v_existing.status
        when 'reserved' then 'reserved'
        else v_existing.status
      end,
      'reservation_id', v_existing.id,
      'claim_token', v_existing.claim_token,
      'lease_epoch', v_existing.lease_epoch,
      'reserved_units', v_existing.reserved_units,
      'expires_at', v_existing.expires_at,
      'idempotent_replay', true
    );
  end if;

  select matrix.* into strict v_matrix
  from billing.pricing_matrices as matrix
  where matrix.version = v_policy.pricing_matrix_version;

  select coalesce(sum(reservation.reserved_units), 0) into v_outstanding
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id
    and reservation.status = 'reserved'
    and reservation.expires_at > v_now;

  if v_outstanding + p_units > v_policy.budget_units then
    return jsonb_build_object(
      'status', 'denied_budget',
      'outstanding_units', v_outstanding,
      'budget_units', v_policy.budget_units
    );
  end if;

  v_remaining_needed := p_units;
  v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  -- FEFO, locked (not skip locked): a scarce bucket must serialize concurrent reservers so that
  -- exactly as many admissions succeed as there are units, deterministically. See ADR 003 §4.1.
  for v_bucket in
    select bucket.id, bucket.remaining_units
    from billing.usage_buckets as bucket
    where bucket.account_id = p_account_id
      and bucket.remaining_units > 0
      and bucket.expires_at > v_now
    order by bucket.expires_at asc, bucket.id asc
    for update
  loop
    exit when v_remaining_needed <= 0;
    v_take := least(v_bucket.remaining_units, v_remaining_needed);
    v_bucket_ids := v_bucket_ids || v_bucket.id;
    v_alloc_units := v_alloc_units || v_take;
    v_remaining_needed := v_remaining_needed - v_take;
  end loop;

  if v_remaining_needed > 0 then
    return jsonb_build_object(
      'status', 'denied_insufficient_units',
      'requested_units', p_units,
      'short_by', v_remaining_needed
    );
  end if;

  insert into billing.usage_reservations (
    id, account_id, idempotency_key, claim_token, lease_epoch, owner_token,
    status, reserved_units, policy_snapshot, expires_at
  ) values (
    v_reservation_id, p_account_id, p_idempotency_key, v_claim_token, 0, p_owner_token,
    'reserved', p_units,
    jsonb_build_object(
      'pricing_matrix_version', v_matrix.version,
      'budget_units', v_policy.budget_units,
      'conversion_rules', v_matrix.conversion_rules
    ),
    v_expires_at
  );

  update billing.usage_buckets as bucket
  set remaining_units = bucket.remaining_units - alloc.units
  from (
    select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units
  ) as alloc
  where bucket.account_id = p_account_id and bucket.id = alloc.id;

  insert into billing.usage_reservation_allocations (account_id, reservation_id, bucket_id, allocated_units)
  select p_account_id, v_reservation_id, alloc.id, alloc.units
  from (
    select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units
  ) as alloc;

  insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id, idempotency_key)
  select p_account_id, 'reserve', alloc.units, v_reservation_id, alloc.id, p_idempotency_key
  from (
    select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units
  ) as alloc;

  select jsonb_agg(jsonb_build_object('bucket_id', alloc.id, 'allocated_units', alloc.units))
  into v_allocations
  from (select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units) as alloc;

  v_result := jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_reservation_id,
    'claim_token', v_claim_token,
    'lease_epoch', 0,
    'reserved_units', p_units,
    'expires_at', v_expires_at,
    'allocations', coalesce(v_allocations, '[]'::jsonb)
  );
  return v_result;
end
$$;

create function billing.heartbeat_usage(
  p_account_id uuid,
  p_reservation_id uuid,
  p_claim_token uuid,
  p_lease_epoch bigint,
  p_extend_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_extend_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid heartbeat extension';
  end if;

  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;
  if v_reservation.status <> 'reserved' or v_reservation.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'reservation not active';
  end if;
  if v_reservation.claim_token is distinct from p_claim_token
    or v_reservation.lease_epoch is distinct from p_lease_epoch then
    raise exception using errcode = '55000', message = 'reservation ownership mismatch';
  end if;

  update billing.usage_reservations
  set expires_at = v_now + pg_catalog.make_interval(secs => p_extend_seconds)
  where account_id = p_account_id and id = p_reservation_id;

  return jsonb_build_object(
    'status', 'reserved',
    'reservation_id', p_reservation_id,
    'claim_token', p_claim_token,
    'lease_epoch', p_lease_epoch,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_extend_seconds)
  );
end
$$;

create function billing.reclaim_usage_reservation(
  p_account_id uuid,
  p_reservation_id uuid,
  p_new_owner_token text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_new_token uuid := gen_random_uuid();
  v_new_epoch bigint;
begin
  if p_new_owner_token is null or char_length(p_new_owner_token) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid owner token';
  end if;
  if p_lease_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid reclaim lease duration';
  end if;

  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception using errcode = '55000', message = 'reservation not reclaimable';
  end if;
  if v_reservation.expires_at > v_now then
    raise exception using errcode = '55000', message = 'reservation lease has not expired';
  end if;

  v_new_epoch := v_reservation.lease_epoch + 1;
  update billing.usage_reservations
  set claim_token = v_new_token,
      lease_epoch = v_new_epoch,
      owner_token = p_new_owner_token,
      expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  where account_id = p_account_id and id = p_reservation_id;

  return jsonb_build_object(
    'status', 'reserved',
    'reservation_id', p_reservation_id,
    'claim_token', v_new_token,
    'lease_epoch', v_new_epoch,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  );
end
$$;

create function billing.finalize_usage(
  p_account_id uuid,
  p_reservation_id uuid,
  p_claim_token uuid,
  p_lease_epoch bigint,
  p_actual_units bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_refund bigint;
  v_allocated_total bigint;
  v_running_refund bigint := 0;
  v_alloc record;
  v_apply record;
  v_this_refund bigint;
  v_last_id uuid;
  v_result jsonb;
  v_calc_ids uuid[] := '{}';
  v_calc_buckets uuid[] := '{}';
  v_calc_refunds bigint[] := '{}';
begin
  if p_actual_units is null or p_actual_units < 0 then
    raise exception using errcode = '22023', message = 'invalid actual usage';
  end if;

  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_reservation.status = 'finalized' then
    return v_reservation.result;
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception using errcode = '55000', message = 'reservation not active';
  end if;
  if v_reservation.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'reservation expired; reclaim required';
  end if;
  if v_reservation.claim_token is distinct from p_claim_token
    or v_reservation.lease_epoch is distinct from p_lease_epoch then
    raise exception using errcode = '55000', message = 'reservation ownership mismatch';
  end if;
  if p_actual_units > v_reservation.reserved_units then
    raise exception using errcode = '22023', message = 'actual_units exceeds reserved_units';
  end if;

  v_refund := v_reservation.reserved_units - p_actual_units;

  select coalesce(sum(allocation.allocated_units), 0) into v_allocated_total
  from billing.usage_reservation_allocations as allocation
  where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id;

  select allocation.id into v_last_id
  from billing.usage_reservation_allocations as allocation
  where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id
  order by allocation.id desc
  limit 1;

  if v_refund > 0 then
    -- Pass 1: compute the largest-remainder refund split in allocation-id order (pure arithmetic,
    -- no locks taken — this order only decides which allocation absorbs the rounding remainder).
    for v_alloc in
      select allocation.id, allocation.bucket_id, allocation.allocated_units
      from billing.usage_reservation_allocations as allocation
      where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id
      order by allocation.id asc
    loop
      if v_alloc.id = v_last_id then
        v_this_refund := v_refund - v_running_refund;
      else
        v_this_refund := (v_refund * v_alloc.allocated_units) / v_allocated_total;
      end if;
      v_running_refund := v_running_refund + v_this_refund;
      v_calc_ids := v_calc_ids || v_alloc.id;
      v_calc_buckets := v_calc_buckets || v_alloc.bucket_id;
      v_calc_refunds := v_calc_refunds || v_this_refund;
    end loop;

    -- Pass 2: apply the credits and take the bucket row locks in bucket_id-ascending order — the
    -- same global lock order used by release_usage and expire_usage_reservations below, so two
    -- concurrent settlements that happen to share buckets can never deadlock against each other
    -- (see ADR 003 §4.3/§4.4).
    for v_apply in
      select t.id, t.bucket_id, t.refund_units
      from unnest(v_calc_ids, v_calc_buckets, v_calc_refunds) as t(id, bucket_id, refund_units)
      where t.refund_units > 0
      order by t.bucket_id asc, t.id asc
    loop
      update billing.usage_reservation_allocations
      set refunded_units = refunded_units + v_apply.refund_units
      where account_id = p_account_id and id = v_apply.id;

      update billing.usage_buckets
      set remaining_units = remaining_units + v_apply.refund_units
      where account_id = p_account_id and id = v_apply.bucket_id;

      insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id)
      values (p_account_id, 'refund', v_apply.refund_units, p_reservation_id, v_apply.bucket_id);
    end loop;
  end if;

  insert into billing.usage_ledger (account_id, event_type, units, reservation_id)
  values (p_account_id, 'finalize', p_actual_units, p_reservation_id);

  v_result := jsonb_build_object(
    'status', 'finalized',
    'reservation_id', p_reservation_id,
    'reserved_units', v_reservation.reserved_units,
    'actual_units', p_actual_units,
    'refunded_units', v_refund
  );

  update billing.usage_reservations
  set status = 'finalized', actual_units = p_actual_units, result = v_result, finalized_at = v_now
  where account_id = p_account_id and id = p_reservation_id;

  return v_result;
end
$$;

create function billing.release_usage(
  p_account_id uuid,
  p_reservation_id uuid,
  p_claim_token uuid,
  p_lease_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_alloc record;
  v_result jsonb;
begin
  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_reservation.status in ('released', 'expired') then
    return jsonb_build_object(
      'status', v_reservation.status,
      'reservation_id', p_reservation_id,
      'refunded_units', v_reservation.reserved_units
    );
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception using errcode = '55000', message = 'reservation not active';
  end if;
  if v_reservation.claim_token is distinct from p_claim_token
    or v_reservation.lease_epoch is distinct from p_lease_epoch then
    raise exception using errcode = '55000', message = 'reservation ownership mismatch';
  end if;

  -- Deterministic bucket_id-ascending lock order — matches finalize_usage's pass 2 and
  -- expire_usage_reservations below, so concurrent settlements sharing buckets never deadlock.
  for v_alloc in
    select allocation.id, allocation.bucket_id, allocation.allocated_units, allocation.refunded_units
    from billing.usage_reservation_allocations as allocation
    where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id
    order by allocation.bucket_id asc, allocation.id asc
  loop
    update billing.usage_reservation_allocations
    set refunded_units = allocation.allocated_units
    from (select v_alloc.allocated_units as allocated_units) as allocation
    where account_id = p_account_id and id = v_alloc.id;

    update billing.usage_buckets
    set remaining_units = remaining_units + (v_alloc.allocated_units - v_alloc.refunded_units)
    where account_id = p_account_id and id = v_alloc.bucket_id;

    insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id)
    values (
      p_account_id, 'release', v_alloc.allocated_units - v_alloc.refunded_units,
      p_reservation_id, v_alloc.bucket_id
    );
  end loop;

  v_result := jsonb_build_object(
    'status', 'released',
    'reservation_id', p_reservation_id,
    'refunded_units', v_reservation.reserved_units
  );

  update billing.usage_reservations
  set status = 'released', result = v_result, released_at = v_now
  where account_id = p_account_id and id = p_reservation_id;

  return v_result;
end
$$;

create function billing.expire_usage_reservations(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_reservation record;
  v_alloc record;
  v_expired_count integer := 0;
  v_expired_units bigint := 0;
begin
  if p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'invalid expiry batch limit';
  end if;

  for v_reservation in
    select reservation.account_id, reservation.id, reservation.reserved_units
    from billing.usage_reservations as reservation
    where reservation.status = 'reserved' and reservation.expires_at <= v_now
    order by reservation.account_id, reservation.expires_at, reservation.id
    for update skip locked
    limit p_limit
  loop
    -- Deterministic bucket_id-ascending lock order — matches finalize_usage/release_usage above.
    for v_alloc in
      select allocation.id, allocation.bucket_id, allocation.allocated_units, allocation.refunded_units
      from billing.usage_reservation_allocations as allocation
      where allocation.account_id = v_reservation.account_id
        and allocation.reservation_id = v_reservation.id
      order by allocation.bucket_id asc, allocation.id asc
    loop
      update billing.usage_reservation_allocations
      set refunded_units = v_alloc.allocated_units
      where account_id = v_reservation.account_id and id = v_alloc.id;

      update billing.usage_buckets
      set remaining_units = remaining_units + (v_alloc.allocated_units - v_alloc.refunded_units)
      where account_id = v_reservation.account_id and id = v_alloc.bucket_id;

      insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id)
      values (
        v_reservation.account_id, 'expire', v_alloc.allocated_units - v_alloc.refunded_units,
        v_reservation.id, v_alloc.bucket_id
      );
    end loop;

    update billing.usage_reservations
    set status = 'expired',
        result = jsonb_build_object(
          'status', 'expired', 'reservation_id', v_reservation.id,
          'refunded_units', v_reservation.reserved_units
        ),
        released_at = v_now
    where account_id = v_reservation.account_id and id = v_reservation.id;

    v_expired_count := v_expired_count + 1;
    v_expired_units := v_expired_units + v_reservation.reserved_units;
  end loop;

  return jsonb_build_object('expired_count', v_expired_count, 'expired_units', v_expired_units);
end
$$;

revoke all on function billing.reserve_usage(uuid, text, bigint, text, integer)
  from public, anon, authenticated;
revoke all on function billing.heartbeat_usage(uuid, uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function billing.reclaim_usage_reservation(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function billing.finalize_usage(uuid, uuid, uuid, bigint, bigint)
  from public, anon, authenticated;
revoke all on function billing.release_usage(uuid, uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function billing.expire_usage_reservations(integer)
  from public, anon, authenticated;

grant execute on function billing.reserve_usage(uuid, text, bigint, text, integer) to service_role;
grant execute on function billing.heartbeat_usage(uuid, uuid, uuid, bigint, integer) to service_role;
grant execute on function billing.reclaim_usage_reservation(uuid, uuid, text, integer) to service_role;
grant execute on function billing.finalize_usage(uuid, uuid, uuid, bigint, bigint) to service_role;
grant execute on function billing.release_usage(uuid, uuid, uuid, bigint) to service_role;
grant execute on function billing.expire_usage_reservations(integer) to service_role;

comment on function billing.reserve_usage(uuid, text, bigint, text, integer) is
  'Fail-closed FEFO admission: system_controls gate, global cutover gate, per-account policy lock, tenant-idempotent.';
comment on function billing.finalize_usage(uuid, uuid, uuid, bigint, bigint) is
  'Fenced settlement: rejects actual_units > reserved_units, proportional multi-bucket refund in bucket_id lock order, idempotent retry.';
comment on function billing.release_usage(uuid, uuid, uuid, bigint) is
  'Fenced full refund in bucket_id lock order; idempotent on retry once already released or expired.';
comment on function billing.expire_usage_reservations(integer) is
  'Bounded batch sweep of overdue reservations in bucket_id lock order; skip locked is safe on the reservation scan because rows are independent.';
comment on function billing.reclaim_usage_reservation(uuid, uuid, text, integer) is
  'Increments lease_epoch to fence out a stale claim_token after lease expiry.';

-- ─── 20260826100000_billing_legacy_drain_cutover.sql ─────────────────────────────────────────
-- ADR 003: GLOBAL drain-first legacy cutover. billing_legacy schema, one-way whole-environment
-- snapshot gated by runtime.system_controls maintenance + billing_legacy.quad_zero_check, a
-- fail-closed patch of the legacy admission function, atomic maintenance enter/resume, quad-zero
-- check. No per-account cutover path exists: billing.cutover_state (see the schema migration) is
-- a single singleton row, and exactly one of the legacy/v2 admission routes may admit at a time
-- for the whole environment.

create schema billing_legacy;
revoke all on schema billing_legacy from public, anon, authenticated;
grant usage on schema billing_legacy to service_role;

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.drain_snapshots — one row per account, written once by billing.activate_global_
-- cutover inside its single snapshot transaction. Composite FK to billing.usage_buckets scoped by
-- account_id makes a cross-tenant bucket reference structurally impossible; zero-unit accounts get
-- a NULL granted_bucket_id (MATCH SIMPLE lets a NULL column skip FK enforcement).
-- ---------------------------------------------------------------------------------------------

create table billing_legacy.drain_snapshots (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  snapshotted_balance bigint not null,
  granted_bucket_id uuid,
  pricing_matrix_version integer references billing.pricing_matrices (version),
  snapshotted_at timestamptz not null default clock_timestamp(),
  constraint drain_snapshots_balance_check check (snapshotted_balance >= 0),
  constraint drain_snapshots_bucket_fkey
    foreign key (account_id, granted_bucket_id)
    references billing.usage_buckets (account_id, id) on delete restrict
);

revoke all on billing_legacy.drain_snapshots from public, anon, authenticated;

comment on table billing_legacy.drain_snapshots is
  'One-way per-account snapshot row written once, in bulk, by billing.activate_global_cutover.';

-- ---------------------------------------------------------------------------------------------
-- Patch the legacy admission function: add the runtime.system_controls fail-closed check used by
-- public.runtime_claim_workflow, AND the global cutover gate — once billing.cutover_state.v2_active
-- is true, legacy denies unconditionally so the two admission routes can never both admit the same
-- unit of work. Identical signature otherwise, so every existing caller keeps working.
-- finalize_token_usage/release_token_usage are untouched — in-flight legacy reservations created
-- before cutover must still be settleable.
-- ---------------------------------------------------------------------------------------------

create or replace function public.reserve_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_reserved_tokens bigint,
  p_monthly_limit bigint,
  p_run_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.token_usage_reservations;
  balance bigint;
  credits bigint;
  expired_credits bigint;
  used_tokens bigint;
  active_tokens bigint;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_control runtime.system_controls%rowtype;
  v_cutover billing.cutover_state%rowtype;
begin
  if p_account_id is null or p_billing_key is null or length(p_billing_key) not between 1 and 200
    or p_reserved_tokens <= 0 or p_monthly_limit <= 0 then raise exception 'invalid reservation input'; end if;

  -- Fail-closed admission gate, matching public.runtime_claim_workflow (ADR 001/003). Returned as
  -- a denied status, not an exception, to preserve this function's existing denied_* contract.
  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then
    return jsonb_build_object('status', 'denied_kill_switch');
  end if;

  -- Global cutover gate: once billing.activate_global_cutover has run, legacy denies
  -- unconditionally. Mirror of the v2_active check in billing.reserve_usage — see ADR 003 §5.
  select cutover.* into strict v_cutover
  from billing.cutover_state as cutover
  where cutover.singleton
  for share;
  if v_cutover.v2_active then
    return jsonb_build_object('status', 'denied_cutover_active');
  end if;

  perform 1 from public.autonomous_run_checkpoints where id = p_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token for update;
  if not found then raise exception 'worker claim lost'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  select token_balance into balance from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  with released as (
    update public.token_usage_reservations
    set status = 'expired'
    where account_id = p_account_id and status = 'active' and expires_at <= now()
    returning reserved_credits
  ) select coalesce(sum(reserved_credits), 0) into expired_credits from released;
  balance := balance + expired_credits;
  if expired_credits > 0 then update public.accounts set token_balance = balance where id = p_account_id; end if;

  credits := ceil(p_reserved_tokens / 1000.0)::bigint;
  select coalesce(sum(tokens), 0) into used_tokens from public.usage
  where account_id = p_account_id and created_at >= month_start;
  select coalesce(sum(reserved_tokens), 0) into active_tokens from public.token_usage_reservations
  where account_id = p_account_id and status = 'active';

  if balance < credits then return jsonb_build_object('status', 'denied_balance'); end if;
  if used_tokens + active_tokens + p_reserved_tokens > p_monthly_limit then return jsonb_build_object('status', 'denied_quota'); end if;

  insert into public.token_usage_reservations(account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, expires_at)
  values (p_account_id, p_billing_key, p_run_id, p_claim_token, p_reserved_tokens, credits, p_monthly_limit, now() + interval '10 minutes')
  on conflict (account_id, billing_key) do update
    set reserved_tokens = excluded.reserved_tokens,
        reserved_credits = excluded.reserved_credits,
        monthly_limit = excluded.monthly_limit,
        run_id = excluded.run_id,
        claim_token = excluded.claim_token,
        status = 'active', result = null, actual_tokens = null,
        expires_at = excluded.expires_at, finalized_at = null;
  update public.accounts set token_balance = balance - credits where id = p_account_id;
  return jsonb_build_object('status', 'reserved');
end
$$;

revoke all on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) from public, anon, authenticated;
grant execute on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) to service_role;

comment on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) is
  'ADR 003: legacy admission, now fail-closed on runtime.system_controls kill switch / claims pause.';

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.expire_legacy_reservations — bounded cleanup, exactly-once refund, deterministic
-- account lock order to avoid deadlocks with other account-locking processes.
-- ---------------------------------------------------------------------------------------------

create function billing_legacy.expire_legacy_reservations(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_expired_count integer := 0;
  v_refunded_credits bigint := 0;
  v_rows_touched integer;
begin
  if p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'invalid expiry batch limit';
  end if;

  for v_row in
    select reservation.id, reservation.account_id, reservation.reserved_credits
    from public.token_usage_reservations as reservation
    where reservation.status = 'active' and reservation.expires_at <= now()
    order by reservation.account_id, reservation.expires_at, reservation.id
    for update skip locked
    limit p_limit
  loop
    -- Lock the account row before mutating it; scan order above is already account_id-ascending,
    -- so this preserves a single deterministic lock order across concurrent cleanup runs.
    perform 1 from public.accounts where id = v_row.account_id for update;

    -- Guard the refund inside the same statement as the terminal status transition so a retry of
    -- this loop iteration (or a concurrent cleanup run that skipped the row-lock race) can never
    -- refund the same reservation twice: the WHERE clause only matches while still 'active'.
    with settled as (
      update public.token_usage_reservations
      set status = 'expired'
      where id = v_row.id and account_id = v_row.account_id and status = 'active'
      returning reserved_credits
    )
    update public.accounts as account
    set token_balance = account.token_balance + settled.reserved_credits
    from settled
    where account.id = v_row.account_id;

    get diagnostics v_rows_touched = row_count;
    if v_rows_touched > 0 then
      v_expired_count := v_expired_count + 1;
      v_refunded_credits := v_refunded_credits + v_row.reserved_credits;
    end if;
  end loop;

  return jsonb_build_object('expired_count', v_expired_count, 'refunded_credits', v_refunded_credits);
end
$$;

revoke all on function billing_legacy.expire_legacy_reservations(integer) from public, anon, authenticated;
grant execute on function billing_legacy.expire_legacy_reservations(integer) to service_role;

comment on function billing_legacy.expire_legacy_reservations(integer) is
  'Service-role-only cleanup: refunds overdue legacy reservations exactly once via a guarded status transition.';

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.quad_zero_check — read-only cutover readiness signal
-- ---------------------------------------------------------------------------------------------

create function billing_legacy.quad_zero_check()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'autonomous_run_checkpoints_nonterminal', (
      select count(*) from public.autonomous_run_checkpoints
      where status in ('active', 'queued', 'running')
    ),
    'workflow_runs_nonterminal', (
      select count(*) from runtime.workflow_runs
      where current_state not in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled')
    ),
    'compute_jobs_pending_or_running', (
      select count(*) from runtime.compute_jobs
      where status in ('pending', 'running')
    ),
    'token_usage_reservations_active', (
      select count(*) from public.token_usage_reservations where status = 'active'
    )
  );
$$;

revoke all on function billing_legacy.quad_zero_check() from public, anon, authenticated;
grant execute on function billing_legacy.quad_zero_check() to service_role;

comment on function billing_legacy.quad_zero_check() is
  'Read-only. All four counts must be zero, per account fully drained, before the manual revoke runbook in ADR 003 §5.';

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.reconciliation_report — read-only migration reconciliation, computed directly
-- from drain_snapshots joined to the pricing matrix each snapshot was converted under, the
-- legacy_migration bucket it funded, and the grant ledger row that recorded the funding. This is
-- the actual cutover-migration check (conservation of buckets/allocations/ledger under ongoing
-- reserve/finalize/release traffic is a separate, already-covered invariant — see
-- supabase/tests/billing_usage_invariants.sql).
-- ---------------------------------------------------------------------------------------------

create function billing_legacy.reconciliation_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_expected_units bigint;
  v_bucket_units bigint;
  v_ledger_grant_units bigint;
  v_mismatched_accounts integer;
begin
  select coalesce(sum(
    greatest(floor(
      snapshot.snapshotted_balance * (matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric
    )::bigint, 0)
  ), 0)
  into v_expected_units
  from billing_legacy.drain_snapshots as snapshot
  join billing.pricing_matrices as matrix on matrix.version = snapshot.pricing_matrix_version;

  select coalesce(sum(bucket.total_units), 0)
  into v_bucket_units
  from billing_legacy.drain_snapshots as snapshot
  join billing.usage_buckets as bucket
    on bucket.account_id = snapshot.account_id and bucket.id = snapshot.granted_bucket_id;

  select coalesce(sum(ledger.units), 0)
  into v_ledger_grant_units
  from billing_legacy.drain_snapshots as snapshot
  join billing.usage_ledger as ledger
    on ledger.account_id = snapshot.account_id and ledger.bucket_id = snapshot.granted_bucket_id
   and ledger.event_type = 'grant';

  select count(*)
  into v_mismatched_accounts
  from billing_legacy.drain_snapshots as snapshot
  join billing.pricing_matrices as matrix on matrix.version = snapshot.pricing_matrix_version
  left join billing.usage_buckets as bucket
    on bucket.account_id = snapshot.account_id and bucket.id = snapshot.granted_bucket_id
  left join billing.usage_ledger as ledger
    on ledger.account_id = snapshot.account_id and ledger.bucket_id = snapshot.granted_bucket_id
   and ledger.event_type = 'grant'
  where greatest(floor(
          snapshot.snapshotted_balance * (matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric
        )::bigint, 0) is distinct from coalesce(bucket.total_units, 0)
     or greatest(floor(
          snapshot.snapshotted_balance * (matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric
        )::bigint, 0) is distinct from coalesce(ledger.units, 0);

  return jsonb_build_object(
    'expected_units', v_expected_units,
    'bucket_units', v_bucket_units,
    'ledger_grant_units', v_ledger_grant_units,
    'bucket_delta', v_bucket_units - v_expected_units,
    'ledger_delta', v_ledger_grant_units - v_expected_units,
    'mismatched_accounts', v_mismatched_accounts
  );
end
$$;

revoke all on function billing_legacy.reconciliation_report() from public, anon, authenticated;
grant execute on function billing_legacy.reconciliation_report() to service_role;

comment on function billing_legacy.reconciliation_report() is
  'Read-only. Recomputes expected legacy-migration units from drain_snapshots x pricing_matrices and compares against actual usage_buckets/usage_ledger; all deltas/mismatches must be zero before global cutover activates.';

-- ---------------------------------------------------------------------------------------------
-- runtime.enter_billing_maintenance — atomic entering half of a maintenance transition. There was
-- previously no RPC for this (operators set the pause flags directly); billing.activate_global_
-- cutover requires claims_paused AND ingestion_paused to already be true with valid metadata
-- before it will run, so a dedicated, validated, service-role-only entry point replaces the manual
-- direct UPDATE. Does not touch kill_switch_active — this is a metering-admission maintenance
-- window, not the workflow-runtime kill switch, and the two are independently controllable
-- (system_controls_kill_switch_check only requires claims_paused when kill_switch_active is set,
-- not the reverse).
-- ---------------------------------------------------------------------------------------------

create function runtime.enter_billing_maintenance(p_actor text, p_reason_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row runtime.system_controls%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor is null or char_length(p_actor) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid maintenance actor';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid maintenance reason code';
  end if;

  -- Kill switch independence (ADR 003 §5): the kill switch is an unrelated incident control.
  -- Fail closed rather than silently overwriting its reason_code/activated_by/activated_at.
  select controls.* into strict v_row
  from runtime.system_controls as controls
  where controls.singleton
  for update;
  if v_row.kill_switch_active then
    raise exception using errcode = '55000',
      message = 'kill switch is active; billing maintenance cannot start until it is cleared independently';
  end if;

  -- Single atomic UPDATE: flags on and metadata set together, matching
  -- system_controls_activation_check (ADR 003 §5).
  update runtime.system_controls
  set claims_paused = true,
      ingestion_paused = true,
      reason_code = p_reason_code,
      activated_by = p_actor,
      activated_at = v_now,
      control_epoch = control_epoch + 1,
      updated_at = v_now
  where singleton
  returning * into v_row;

  return jsonb_build_object(
    'claims_paused', v_row.claims_paused,
    'ingestion_paused', v_row.ingestion_paused,
    'reason_code', v_row.reason_code,
    'activated_by', v_row.activated_by,
    'activated_at', v_row.activated_at,
    'control_epoch', v_row.control_epoch
  );
end
$$;

revoke all on function runtime.enter_billing_maintenance(text, text) from public, anon, authenticated;
grant execute on function runtime.enter_billing_maintenance(text, text) to service_role;

comment on function runtime.enter_billing_maintenance(text, text) is
  'ADR 003: single atomic UPDATE setting claims_paused + ingestion_paused and maintenance metadata together.';

-- ---------------------------------------------------------------------------------------------
-- runtime.resume_from_maintenance — atomic clearing half of a maintenance transition
-- ---------------------------------------------------------------------------------------------

create function runtime.resume_from_maintenance(p_actor text, p_reason_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row runtime.system_controls%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor is null or char_length(p_actor) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid resume actor';
  end if;
  -- p_reason_code is optional (why the resume happened need not match the entering reason_code),
  -- but if supplied it must still be a well-formed reason code, and it is returned to the caller
  -- to log — it is not a dead parameter.
  if p_reason_code is not null and p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid resume reason code';
  end if;

  -- Kill switch independence (ADR 003 §5): this RPC clears billing maintenance only. It must never
  -- change kill_switch_active, and must fail closed if an incident is still active so a billing
  -- resume can never be mistaken for clearing the kill switch.
  select controls.* into strict v_row
  from runtime.system_controls as controls
  where controls.singleton
  for update;
  if v_row.kill_switch_active then
    raise exception using errcode = '55000',
      message = 'kill switch is active; clear it independently before resuming from billing maintenance';
  end if;

  -- Single atomic UPDATE: flags off and metadata cleared together, matching
  -- system_controls_activation_check (ADR 003 §5). The resume actor/reason are audited via
  -- runtime.audit_events, not stored on the now-inactive singleton row.
  -- runtime.audit_events requires a tenant account_id and workflow-scoped correlation_id; this is
  -- a control-plane, not tenant-scoped, action, so it does not fit that table. The resume actor
  -- and reason are returned to the caller (an operator-facing Edge Function) to log instead.
  update runtime.system_controls
  set claims_paused = false,
      ingestion_paused = false,
      reason_code = null,
      activated_by = null,
      activated_at = null,
      control_epoch = control_epoch + 1,
      updated_at = v_now
  where singleton
  returning * into v_row;

  return jsonb_build_object(
    'resumed_by', p_actor,
    'resume_reason_code', p_reason_code,
    'resumed_at', v_now,
    'control_epoch', v_row.control_epoch
  );
end
$$;

revoke all on function runtime.resume_from_maintenance(text, text) from public, anon, authenticated;
grant execute on function runtime.resume_from_maintenance(text, text) to service_role;

comment on function runtime.resume_from_maintenance(text, text) is
  'ADR 003: single atomic UPDATE clearing all system_controls pause flags and metadata together.';

-- ---------------------------------------------------------------------------------------------
-- billing.activate_global_cutover — the one-way, whole-environment cutover. Requires the caller to
-- have already put the system into maintenance via runtime.enter_billing_maintenance (claims_paused
-- AND ingestion_paused, with reason_code/activated_by/activated_at all set) and requires
-- billing_legacy.quad_zero_check() to report all four counts as exactly zero. On success: snapshots
-- every account deterministically (ascending account_id, all locked for update in the same
-- transaction as this function body), grants source='legacy_migration' buckets with a 12-month TTL
-- funded by the active pricing matrix's legacy_credit_to_unit conversion, writes one append-only
-- 'grant' ledger row per funded account, then atomically clears the maintenance flags/metadata
-- (same shape as runtime.resume_from_maintenance) and flips billing.cutover_state.v2_active — all
-- in the one transaction this function body runs in. This function is defined here but never
-- invoked by any migration: the actual cutover is a manual, per-environment operator action (see
-- ADR 003 §5), run only after a human has read quad_zero_check() output for that specific
-- environment.
-- ---------------------------------------------------------------------------------------------

create function billing.activate_global_cutover(p_actor text, p_reason_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutover billing.cutover_state%rowtype;
  v_control runtime.system_controls%rowtype;
  v_quad jsonb;
  v_matrix billing.pricing_matrices%rowtype;
  v_factor numeric;
  v_now timestamptz := clock_timestamp();
  v_account record;
  v_granted_units bigint;
  v_bucket_id uuid;
  v_accounts_migrated integer := 0;
  v_units_migrated bigint := 0;
  v_new_control_epoch bigint;
  v_reconciliation jsonb;
begin
  if p_actor is null or char_length(p_actor) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid activation actor';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid activation reason code';
  end if;

  -- Lock system_controls before cutover_state (same order as the reserve/maintenance paths) and
  -- check the kill switch BEFORE the already-active short-circuit below: a kill switch activated
  -- after v2 is already live must still fail this call closed rather than silently no-op-succeeding.
  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for update;
  if v_control.kill_switch_active then
    raise exception using errcode = '55000',
      message = 'kill switch is active; global cutover cannot run until it is cleared independently';
  end if;

  select cutover.* into strict v_cutover
  from billing.cutover_state as cutover
  where cutover.singleton
  for update;
  if v_cutover.v2_active then
    return jsonb_build_object(
      'status', 'already_active',
      'activated_at', v_cutover.activated_at,
      'cutover_epoch', v_cutover.cutover_epoch
    );
  end if;

  if not (v_control.claims_paused and v_control.ingestion_paused) then
    raise exception using errcode = '55000',
      message = 'global cutover requires claims_paused and ingestion_paused; call runtime.enter_billing_maintenance first';
  end if;
  if v_control.reason_code is null or v_control.activated_by is null or v_control.activated_at is null then
    raise exception using errcode = '55000', message = 'system_controls maintenance metadata incomplete';
  end if;

  v_quad := billing_legacy.quad_zero_check();
  if (v_quad ->> 'autonomous_run_checkpoints_nonterminal')::integer <> 0
    or (v_quad ->> 'workflow_runs_nonterminal')::integer <> 0
    or (v_quad ->> 'compute_jobs_pending_or_running')::integer <> 0
    or (v_quad ->> 'token_usage_reservations_active')::integer <> 0 then
    raise exception using errcode = '55000',
      message = format('quad-zero check not clear, cannot activate global cutover: %s', v_quad);
  end if;

  select matrix.* into v_matrix
  from billing.pricing_matrices as matrix
  where matrix.is_active
  limit 1;
  if not found then
    raise exception using errcode = '55000', message = 'no active pricing matrix for global cutover conversion';
  end if;
  v_factor := coalesce((v_matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric, 0);
  if v_factor <= 0 then
    raise exception using errcode = '55000',
      message = 'pricing matrix missing legacy_credit_to_unit conversion rule';
  end if;

  -- Deterministic, single-transaction snapshot of every account, locked in ascending account_id
  -- order. Explicit conversion (never implicit 1:1) via legacy_credit_to_unit, exactly like
  -- billing_legacy.expire_legacy_reservations locks accounts in the same ascending order.
  for v_account in
    select account.id, account.token_balance
    from public.accounts as account
    order by account.id
    for update
  loop
    if exists (
      select 1 from billing_legacy.drain_snapshots as snapshot where snapshot.account_id = v_account.id
    ) then
      continue;
    end if;

    v_granted_units := greatest(floor(v_account.token_balance * v_factor)::bigint, 0);
    v_bucket_id := null;

    -- Composite tenant integrity: zero-unit accounts store a NULL bucket id (ADR 003 §5).
    if v_granted_units > 0 then
      v_bucket_id := gen_random_uuid();
      insert into billing.usage_buckets (
        id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at
      ) values (
        v_bucket_id, v_account.id, 'legacy_migration', v_matrix.version,
        v_granted_units, v_granted_units, v_now + interval '12 months'
      );

      insert into billing.usage_ledger (account_id, event_type, units, bucket_id, details)
      values (
        v_account.id, 'grant', v_granted_units, v_bucket_id,
        jsonb_build_object('reason', 'legacy_migration', 'snapshotted_balance', v_account.token_balance)
      );
      v_units_migrated := v_units_migrated + v_granted_units;
    end if;

    insert into billing_legacy.drain_snapshots (
      account_id, snapshotted_balance, granted_bucket_id, pricing_matrix_version
    ) values (
      v_account.id, v_account.token_balance, v_bucket_id, v_matrix.version
    );

    v_accounts_migrated := v_accounts_migrated + 1;
  end loop;

  -- Fail-closed reconciliation gate (ADR 003 §5): recompute expected legacy-migration units from
  -- the snapshots just written and compare against the buckets/ledger just written, in the same
  -- transaction. Any nonzero delta or mismatch aborts the whole cutover — nothing below this point
  -- (clearing maintenance, flipping v2_active) runs, and the entire transaction rolls back.
  v_reconciliation := billing_legacy.reconciliation_report();
  if (v_reconciliation ->> 'bucket_delta')::bigint <> 0
    or (v_reconciliation ->> 'ledger_delta')::bigint <> 0
    or (v_reconciliation ->> 'mismatched_accounts')::integer <> 0 then
    raise exception using errcode = '55000',
      message = format('cutover reconciliation is not clear, refusing to activate: %s', v_reconciliation);
  end if;

  -- Atomically clear maintenance metadata/flags and bump control_epoch — same shape as
  -- runtime.resume_from_maintenance — in the same transaction as the snapshot loop above.
  update runtime.system_controls
  set claims_paused = false,
      ingestion_paused = false,
      reason_code = null,
      activated_by = null,
      activated_at = null,
      control_epoch = control_epoch + 1,
      updated_at = v_now
  where singleton
  returning control_epoch into v_new_control_epoch;

  update billing.cutover_state
  set v2_active = true,
      activated_by = p_actor,
      reason_code = p_reason_code,
      activated_at = v_now,
      cutover_epoch = cutover_epoch + 1
  where singleton;

  return jsonb_build_object(
    'status', 'activated',
    'activated_by', p_actor,
    'reason_code', p_reason_code,
    'activated_at', v_now,
    'accounts_migrated', v_accounts_migrated,
    'units_migrated', v_units_migrated,
    'system_controls_epoch', v_new_control_epoch,
    'reconciliation', v_reconciliation
  );
end
$$;

revoke all on function billing.activate_global_cutover(text, text) from public, anon, authenticated;
grant execute on function billing.activate_global_cutover(text, text) to service_role;

comment on function billing.activate_global_cutover(text, text) is
  'ADR 003: one-way global cutover. Never invoked by a migration — manual operator action per the runbook.';

-- ─── 20260826110000_order_service_core.sql ───────────────────────────────────────────────────
-- ADR 004: order service core schema — tenant-safe FSM, Kafka domain-event outbox, consumer
-- inbox, and operational inventory. Closed schema: every table is unreachable except through the
-- security-definer RPCs in the companion migration.

create schema commerce_runtime;
revoke all on schema commerce_runtime from public, anon, authenticated;
grant usage on schema commerce_runtime to service_role;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.allowed_order_transitions — FSM legality lookup, not an ENUM (ADR 004 §4.1).
-- 'new' is a sentinel from_state only: the birth transition ('new' -> 'created') is every order's
-- first row, and 'new' is never a legal orders.status value or a legal to_state.
--
-- Lifecycle: created -> inventory_reserved -> payment_pending -> paid -> confirmed -> fulfilling
-- -> shipped -> completed, with inventory_rejected/payment_failed/cancelled/failed as explicit
-- terminal-or-recoverable branches (ADR 004 §4.1).
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.allowed_order_transitions (
  from_state text not null,
  to_state text not null,
  primary key (from_state, to_state),
  constraint allowed_order_transition_from_state_check check (from_state in (
    'new', 'created', 'inventory_reserved', 'payment_pending', 'paid', 'confirmed',
    'fulfilling', 'shipped'
  )),
  constraint allowed_order_transition_to_state_check check (to_state in (
    'created', 'inventory_reserved', 'payment_pending', 'paid', 'confirmed', 'fulfilling',
    'shipped', 'completed', 'inventory_rejected', 'payment_failed', 'cancelled', 'failed'
  )),
  constraint allowed_order_transition_not_identity_check check (from_state <> to_state)
);

insert into commerce_runtime.allowed_order_transitions (from_state, to_state) values
  ('new', 'created'),
  ('created', 'inventory_reserved'),
  ('created', 'inventory_rejected'),
  ('created', 'cancelled'),
  ('inventory_reserved', 'payment_pending'),
  ('inventory_reserved', 'cancelled'),
  ('payment_pending', 'paid'),
  ('payment_pending', 'payment_failed'),
  ('payment_pending', 'cancelled'),
  ('paid', 'confirmed'),
  ('paid', 'cancelled'),
  ('confirmed', 'fulfilling'),
  ('confirmed', 'cancelled'),
  ('confirmed', 'failed'),
  ('fulfilling', 'shipped'),
  ('fulfilling', 'failed'),
  ('shipped', 'completed'),
  ('shipped', 'failed');

revoke all on commerce_runtime.allowed_order_transitions from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.orders
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  idempotency_key text not null,
  payload_hash text not null,
  status text not null default 'created',
  state_version bigint not null default 1,
  currency text not null,
  total_amount_minor bigint not null,
  customer_ref text,
  order_payload jsonb not null default '{}'::jsonb,
  correlation_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint orders_account_id_id_key unique (account_id, id),
  constraint orders_idempotency_key unique (account_id, idempotency_key),
  constraint orders_idempotency_key_shape_check check (
    char_length(idempotency_key) between 1 and 200
  ),
  constraint orders_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint orders_status_check check (
    status in (
      'created', 'inventory_reserved', 'payment_pending', 'paid', 'confirmed', 'fulfilling',
      'shipped', 'completed', 'inventory_rejected', 'payment_failed', 'cancelled', 'failed'
    )
  ),
  -- state_version is 1-based: the birth transition (transition_seq = 1) is applied in the same
  -- transaction as the insert, so an order is never observed at version 0 (ADR 004 §4.2).
  constraint orders_state_version_check check (state_version >= 1),
  constraint orders_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint orders_total_amount_check check (total_amount_minor >= 0),
  constraint orders_customer_ref_check check (
    customer_ref is null or char_length(customer_ref) between 1 and 200
  ),
  constraint orders_payload_object_check check (jsonb_typeof(order_payload) = 'object'),
  constraint orders_payload_size_check check (octet_length(order_payload::text) <= 65536),
  constraint orders_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  )
);

create index orders_account_status_idx on commerce_runtime.orders (account_id, status, created_at);

revoke all on commerce_runtime.orders from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.order_transitions — append-only, immutable trigger, initial 'created' row.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.order_transitions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  order_id uuid not null,
  transition_seq bigint not null,
  from_state text not null,
  to_state text not null,
  actor_type text not null,
  actor_id text not null,
  correlation_id text,
  reason_code text,
  transition_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint order_transitions_account_id_id_key unique (account_id, id),
  constraint order_transitions_order_fkey foreign key (account_id, order_id)
    references commerce_runtime.orders (account_id, id) on delete restrict,
  constraint order_transitions_pair_fkey foreign key (from_state, to_state)
    references commerce_runtime.allowed_order_transitions (from_state, to_state) on delete restrict,
  constraint order_transitions_seq_check check (transition_seq > 0),
  constraint order_transitions_seq_unique unique (account_id, order_id, transition_seq),
  constraint order_transitions_actor_type_check check (
    actor_type in ('system', 'worker', 'user', 'admin', 'maintenance')
  ),
  constraint order_transitions_actor_id_check check (char_length(actor_id) between 1 and 160),
  constraint order_transitions_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  ),
  constraint order_transitions_reason_check check (
    reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint order_transitions_payload_object_check check (
    jsonb_typeof(transition_payload) = 'object'
  ),
  constraint order_transitions_payload_size_check check (
    octet_length(transition_payload::text) <= 16384
  )
);

create index order_transitions_order_idx
  on commerce_runtime.order_transitions (account_id, order_id, transition_seq);

revoke all on commerce_runtime.order_transitions from public, anon, authenticated;

create function commerce_runtime.prevent_order_transition_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '0OS01', message = 'order_transitions is append-only';
end
$$;

create trigger order_transitions_immutable
  before update or delete on commerce_runtime.order_transitions
  for each row execute function commerce_runtime.prevent_order_transition_mutation();

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.order_outbox_events — Kafka domain-event outbox (ADR 004 §3.1, §4.4). Distinct
-- from runtime.outbox_actions, which is a policy-controlled external side-effect queue tied to the
-- durable-operations runtime's workflow/policy/approval lineage; this table has no such lineage and
-- instead carries event/schema versions for Kafka consumer evolution. Kafka partition key is the
-- existing order_id column — no separate partition-key column is needed.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.order_outbox_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  order_id uuid not null,
  event_type text not null,
  event_version text not null default 'v1',
  schema_version text not null default 'order-outbox-v1',
  payload jsonb not null default '{}'::jsonb,
  payload_hash text not null,
  dedupe_key text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz,
  claim_token uuid,
  lease_holder text,
  lease_until timestamptz,
  lease_epoch bigint not null default 0,
  published_at timestamptz,
  last_error_code text,
  sanitized_error_message text,
  correlation_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint order_outbox_events_account_id_id_key unique (account_id, id),
  constraint order_outbox_events_order_fkey foreign key (account_id, order_id)
    references commerce_runtime.orders (account_id, id) on delete restrict,
  constraint order_outbox_events_dedupe_key unique (account_id, dedupe_key),
  constraint order_outbox_events_type_check check (char_length(event_type) between 1 and 160),
  constraint order_outbox_events_event_version_check check (
    char_length(event_version) between 1 and 40
  ),
  constraint order_outbox_events_schema_version_check check (
    char_length(schema_version) between 1 and 60
  ),
  constraint order_outbox_events_status_check check (
    status in ('pending', 'processing', 'retry_scheduled', 'published', 'dead_letter')
  ),
  constraint order_outbox_events_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint order_outbox_events_payload_size_check check (octet_length(payload::text) <= 65536),
  constraint order_outbox_events_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint order_outbox_events_dedupe_key_shape_check check (
    char_length(dedupe_key) between 1 and 300
  ),
  constraint order_outbox_events_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 50 and attempt_count <= max_attempts
  ),
  constraint order_outbox_events_retry_time_check check (
    (status = 'retry_scheduled' and next_attempt_at is not null)
    or (status <> 'retry_scheduled' and next_attempt_at is null)
  ),
  constraint order_outbox_events_lease_integrity_check check (
    (status = 'processing' and claim_token is not null and lease_holder is not null
      and lease_until is not null)
    or (status <> 'processing' and claim_token is null and lease_until is null)
  ),
  constraint order_outbox_events_lease_epoch_check check (lease_epoch >= 0),
  constraint order_outbox_events_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint order_outbox_events_published_check check (
    (status = 'published' and published_at is not null)
    or (status <> 'published' and published_at is null)
  ),
  constraint order_outbox_events_error_code_check check (
    last_error_code is null or char_length(last_error_code) between 1 and 120
  ),
  constraint order_outbox_events_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 2000
  ),
  constraint order_outbox_events_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  )
);

create index order_outbox_events_pending_idx
  on commerce_runtime.order_outbox_events (created_at, id)
  where status = 'pending';
create index order_outbox_events_retry_idx
  on commerce_runtime.order_outbox_events (next_attempt_at, id)
  where status = 'retry_scheduled';
create index order_outbox_events_lease_idx
  on commerce_runtime.order_outbox_events (lease_until, id)
  where status = 'processing';
create index order_outbox_events_order_idx
  on commerce_runtime.order_outbox_events (account_id, order_id);

revoke all on commerce_runtime.order_outbox_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.consumer_inbox — tenant-scoped dedupe for inbound Kafka messages this service
-- consumes. Dedupe alone lives here; the atomic dedupe+mutation pattern is in
-- commerce_runtime.consume_order_event (companion RPC migration, ADR 004 §5.5). This table does
-- not by itself guarantee exactly-once delivery, only exactly-once effect application per message
-- actually delivered to that RPC.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.consumer_inbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  source_topic text not null,
  external_message_id text not null,
  external_message_id_hash text not null,
  order_id uuid,
  payload jsonb not null default '{}'::jsonb,
  correlation_id text,
  consumed_at timestamptz not null default clock_timestamp(),
  constraint consumer_inbox_account_id_id_key unique (account_id, id),
  constraint consumer_inbox_order_fkey foreign key (account_id, order_id)
    references commerce_runtime.orders (account_id, id) on delete restrict,
  constraint consumer_inbox_dedupe_key unique (account_id, source_topic, external_message_id_hash),
  constraint consumer_inbox_source_topic_check check (
    char_length(source_topic) between 1 and 160
  ),
  constraint consumer_inbox_external_id_check check (
    char_length(external_message_id) between 1 and 512
  ),
  constraint consumer_inbox_external_id_hash_check check (
    external_message_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint consumer_inbox_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint consumer_inbox_payload_size_check check (octet_length(payload::text) <= 65536),
  constraint consumer_inbox_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  )
);

create index consumer_inbox_order_idx on commerce_runtime.consumer_inbox (account_id, order_id);

revoke all on commerce_runtime.consumer_inbox from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.inventory — operational stock, not the append-only
-- public.commerce_inventory_snapshots observational table (ADR 004 §3.2, §4.6).
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.inventory (
  account_id uuid not null references public.accounts (id) on delete cascade,
  product_id uuid not null,
  available bigint not null default 0,
  reserved bigint not null default 0,
  version bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint inventory_pkey primary key (account_id, product_id),
  constraint inventory_available_check check (available >= 0),
  constraint inventory_reserved_check check (reserved >= 0),
  constraint inventory_version_check check (version >= 0)
);

revoke all on commerce_runtime.inventory from public, anon, authenticated;

comment on schema commerce_runtime is
  'ADR 004 order service: closed schema, RPC-only access, no direct table grants to any role.';
comment on table commerce_runtime.allowed_order_transitions is
  'FSM legality lookup (composite PK), not an ENUM. new is a birth-transition sentinel from_state only.';
comment on table commerce_runtime.orders is
  'Tenant-scoped idempotent order header. state_version (1-based, birth = 1) fences every transition/reservation RPC.';
comment on table commerce_runtime.order_transitions is
  'Append-only FSM audit log; mutation is blocked by trigger, not just convention.';
comment on table commerce_runtime.order_outbox_events is
  'Kafka domain-event outbox, partitioned by order_id. Distinct from runtime.outbox_actions.';
comment on table commerce_runtime.consumer_inbox is
  'Tenant-scoped inbound-message dedupe; see commerce_runtime.consume_order_event for the atomic pattern.';
comment on table commerce_runtime.inventory is
  'Operational stock ledger, one row per (account_id, product_id). Not an append-only snapshot.';

-- ─── 20260826113000_order_service_rpcs.sql ───────────────────────────────────────────────────
-- ADR 004: order service RPCs — idempotent creation, fenced FSM transitions, all-or-nothing
-- multi-SKU inventory reservation, leased Kafka outbox claim/finish, and atomic consumer-inbox
-- dedupe. commerce_runtime stays closed; every legitimate caller is service_role via these RPCs.

create function commerce_runtime.sha256_text(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

create function commerce_runtime.sha256_jsonb(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select commerce_runtime.sha256_text(p_value::text)
$$;

revoke all on function commerce_runtime.sha256_text(text) from public, anon, authenticated;
revoke all on function commerce_runtime.sha256_jsonb(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.create_order — atomic idempotent creation: order + birth transition + domain
-- outbox event, one transaction (ADR 004 §5.1). ON CONFLICT replay returns the existing order only
-- when the canonical payload hash of the immutable inputs matches; a mismatched hash under the same
-- idempotency key is rejected as a collision, never silently overwritten.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.create_order(
  p_account_id uuid,
  p_idempotency_key text,
  p_currency text,
  p_total_amount_minor bigint,
  p_customer_ref text default null,
  p_order_payload jsonb default '{}'::jsonb,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted commerce_runtime.orders%rowtype;
  v_existing commerce_runtime.orders%rowtype;
  v_canonical jsonb;
  v_hash text;
  v_order_id uuid := gen_random_uuid();
  v_birth_event_payload jsonb;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'invalid account id';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'invalid currency code';
  end if;
  if p_total_amount_minor is null or p_total_amount_minor < 0 then
    raise exception using errcode = '22023', message = 'invalid order total';
  end if;
  if p_customer_ref is not null and char_length(p_customer_ref) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid customer reference';
  end if;
  if p_order_payload is null or jsonb_typeof(p_order_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid order payload';
  end if;
  if octet_length(p_order_payload::text) > 65536 then
    raise exception using errcode = '22023', message = 'order payload too large';
  end if;

  v_canonical := jsonb_build_object(
    'currency', p_currency,
    'total_amount_minor', p_total_amount_minor,
    'customer_ref', p_customer_ref,
    'order_payload', p_order_payload
  );
  v_hash := commerce_runtime.sha256_jsonb(v_canonical);

  -- Race-free tenant-scoped idempotency: a plain SELECT ... FOR UPDATE against a key that has no
  -- row yet takes no gap lock in Postgres, so two concurrent identical calls would both find
  -- nothing and both attempt the INSERT below, and one would lose to unique_violation. Instead we
  -- always attempt the INSERT; ON CONFLICT DO NOTHING makes it the arbiter — Postgres itself
  -- serializes concurrent inserters on the (account_id, idempotency_key) unique index and blocks a
  -- losing inserter until the winner's transaction concludes, so by the time control reaches the
  -- "did we win" check below, the winner's row (if it committed) is guaranteed visible.
  insert into commerce_runtime.orders (
    id, account_id, idempotency_key, payload_hash, status, state_version,
    currency, total_amount_minor, customer_ref, order_payload, correlation_id
  ) values (
    v_order_id, p_account_id, p_idempotency_key, v_hash, 'created', 1,
    p_currency, p_total_amount_minor, p_customer_ref, p_order_payload, p_correlation_id
  )
  on conflict (account_id, idempotency_key) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    -- Lost the insert race (or this is a genuine later retry): the winner's row is committed and
    -- visible now, since ON CONFLICT DO NOTHING only reaches "do nothing" after waiting out any
    -- concurrent inserter racing the same conflicting key.
    select order_row.* into v_existing
    from commerce_runtime.orders as order_row
    where order_row.account_id = p_account_id and order_row.idempotency_key = p_idempotency_key;

    if v_existing.payload_hash = v_hash then
      return jsonb_build_object(
        'status', v_existing.status,
        'order_id', v_existing.id,
        'state_version', v_existing.state_version,
        'idempotent_replay', true
      );
    else
      return jsonb_build_object(
        'status', 'idempotency_key_collision',
        'order_id', v_existing.id,
        'idempotent_replay', false
      );
    end if;
  end if;

  -- We won the insert: only the winner creates the birth transition and outbox event, so a
  -- concurrent identical create_order storm produces exactly one order, one birth transition
  -- (transition_seq = 1, matching state_version = 1 the order is born at), and one outbox event.
  insert into commerce_runtime.order_transitions (
    account_id, order_id, transition_seq, from_state, to_state,
    actor_type, actor_id, correlation_id, transition_payload
  ) values (
    p_account_id, v_order_id, 1, 'new', 'created',
    'system', 'create_order', p_correlation_id, '{}'::jsonb
  );

  v_birth_event_payload := jsonb_build_object(
    'order_id', v_order_id, 'status', 'created', 'currency', p_currency,
    'total_amount_minor', p_total_amount_minor
  );

  insert into commerce_runtime.order_outbox_events (
    account_id, order_id, event_type, payload, payload_hash, dedupe_key, correlation_id
  ) values (
    p_account_id, v_order_id, 'order.created', v_birth_event_payload,
    commerce_runtime.sha256_jsonb(v_birth_event_payload),
    v_order_id::text || ':order.created',
    p_correlation_id
  );

  return jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'state_version', 1,
    'idempotent_replay', false
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.transition_order — generic fenced FSM transition (ADR 004 §5.2). Illegal pairs
-- are rejected by the allowed_order_transitions composite FK, not by application logic here.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.transition_order(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order commerce_runtime.orders%rowtype;
  v_now timestamptz := clock_timestamp();
  v_new_version bigint;
  v_payload jsonb := coalesce(p_transition_payload, '{}'::jsonb);
  v_event_payload jsonb;
begin
  if p_to_state is null or char_length(p_to_state) = 0 then
    raise exception using errcode = '22023', message = 'invalid target state';
  end if;
  if p_actor_type not in ('system', 'worker', 'user', 'admin', 'maintenance') then
    raise exception using errcode = '22023', message = 'invalid actor type';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid actor id';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid transition payload';
  end if;
  if octet_length(v_payload::text) > 16384 then
    raise exception using errcode = '22023', message = 'transition payload too large';
  end if;
  if p_reason_code is not null and p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid reason code';
  end if;

  select order_row.* into v_order
  from commerce_runtime.orders as order_row
  where order_row.account_id = p_account_id and order_row.id = p_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  -- Optimistic-concurrency fence: a caller acting on a version that is no longer current is a
  -- stale writer and is rejected outright, not silently applied against whatever the row now is.
  if v_order.state_version <> p_expected_state_version then
    raise exception using errcode = '55000', message = 'stale order state version';
  end if;

  v_new_version := v_order.state_version + 1;

  -- An illegal (from_state, to_state) pair fails here with 23503, before orders is ever updated.
  insert into commerce_runtime.order_transitions (
    account_id, order_id, transition_seq, from_state, to_state,
    actor_type, actor_id, correlation_id, reason_code, transition_payload
  ) values (
    p_account_id, p_order_id, v_new_version, v_order.status, p_to_state,
    p_actor_type, p_actor_id, p_correlation_id, p_reason_code, v_payload
  );

  update commerce_runtime.orders
  set status = p_to_state, state_version = v_new_version, updated_at = v_now
  where account_id = p_account_id and id = p_order_id and state_version = p_expected_state_version;

  v_event_payload := jsonb_build_object(
    'order_id', p_order_id, 'from_state', v_order.status, 'to_state', p_to_state,
    'state_version', v_new_version, 'transition_payload', v_payload
  );

  insert into commerce_runtime.order_outbox_events (
    account_id, order_id, event_type, payload, payload_hash, dedupe_key, correlation_id
  ) values (
    p_account_id, p_order_id, 'order.transitioned', v_event_payload,
    commerce_runtime.sha256_jsonb(v_event_payload),
    p_order_id::text || ':' || p_to_state || ':' || v_new_version::text,
    p_correlation_id
  );

  return jsonb_build_object(
    'status', 'transitioned',
    'order_id', p_order_id,
    'from_state', v_order.status,
    'to_state', p_to_state,
    'state_version', v_new_version
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.reserve_inventory — all-or-nothing multi-SKU reservation (ADR 004 §5.3):
-- validates input, aggregates duplicate product ids, locks every existing requested inventory row
-- in deterministic product_id order (no unlocked pre-check), verifies every locked line has stock
-- before mutating any of them, then reuses transition_order for the created -> inventory_reserved
-- transition on success, or created -> inventory_rejected on missing/insufficient stock, within the
-- same transaction either way.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.reserve_inventory(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_items jsonb,
  p_actor_type text default 'system',
  p_actor_id text default 'reserve_inventory',
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order commerce_runtime.orders%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_quantity bigint;
  v_agg_ids uuid[] := array[]::uuid[];
  v_agg_qty bigint[] := array[]::bigint[];
  v_locked_ids uuid[] := array[]::uuid[];
  v_missing uuid[] := array[]::uuid[];
  v_short jsonb := '[]'::jsonb;
  v_idx int;
  v_row record;
  v_transition_result jsonb;
  v_reason_code text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'invalid reservation items';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception using errcode = '22023', message = 'too many reservation line items';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as elems(value)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'product_id') or not (v_item ? 'quantity') then
      raise exception using errcode = '22023', message = 'invalid reservation item shape';
    end if;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid reservation product id';
    end;

    begin
      v_quantity := (v_item ->> 'quantity')::bigint;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid reservation quantity';
    end;

    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'reservation quantity must be positive';
    end if;

    -- Aggregate duplicate product ids: a caller listing the same SKU twice must not bypass the
    -- stock check by splitting one oversized request into two smaller-looking ones.
    v_idx := array_position(v_agg_ids, v_product_id);
    if v_idx is null then
      v_agg_ids := v_agg_ids || v_product_id;
      v_agg_qty := v_agg_qty || v_quantity;
    else
      v_agg_qty[v_idx] := v_agg_qty[v_idx] + v_quantity;
    end if;
  end loop;

  select order_row.* into v_order
  from commerce_runtime.orders as order_row
  where order_row.account_id = p_account_id and order_row.id = p_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if v_order.state_version <> p_expected_state_version then
    raise exception using errcode = '55000', message = 'stale order state version';
  end if;
  if v_order.status <> 'created' then
    raise exception using errcode = '55000', message = 'order not in a reservable state';
  end if;

  -- Deterministic product_id-ascending lock order: two reservations sharing SKUs can never
  -- deadlock against each other. Locks every EXISTING requested row first (no unlocked pre-check —
  -- a pre-check-then-lock split leaves a window where a concurrent delete between the check and
  -- the lock would make a since-deleted row look present), then determines which requested ids were
  -- never locked (missing) only after the lock loop completes, and verifies every locked line's
  -- stock before mutating any of them (all-or-nothing).
  for v_row in
    select inv.product_id, inv.available
    from commerce_runtime.inventory as inv
    where inv.account_id = p_account_id and inv.product_id = any (v_agg_ids)
    order by inv.product_id asc
    for update
  loop
    v_locked_ids := v_locked_ids || v_row.product_id;
    v_idx := array_position(v_agg_ids, v_row.product_id);
    if v_row.available < v_agg_qty[v_idx] then
      v_short := v_short || jsonb_build_object(
        'product_id', v_row.product_id, 'requested', v_agg_qty[v_idx], 'available', v_row.available
      );
    end if;
  end loop;

  select array_agg(id) into v_missing
  from unnest(v_agg_ids) as id
  where not (id = any (v_locked_ids));

  if array_length(v_missing, 1) > 0 or jsonb_array_length(v_short) > 0 then
    -- Denied reservations do not leave the order sitting in created: they atomically transition it
    -- to inventory_rejected and emit that transition's outbox event, in the same transaction, so a
    -- caller and any downstream consumer both observe a definite terminal-branch outcome rather than
    -- an order that looks merely "not yet reserved" (ADR 004 §5.3).
    v_reason_code := case
      when array_length(v_missing, 1) > 0 then 'INVENTORY_MISSING_ROW'
      else 'INSUFFICIENT_STOCK'
    end;

    select commerce_runtime.transition_order(
      p_account_id, p_order_id, p_expected_state_version, 'inventory_rejected',
      p_actor_type, p_actor_id, p_correlation_id,
      jsonb_build_object(
        'missing_product_ids', to_jsonb(coalesce(v_missing, array[]::uuid[])),
        'short', v_short
      ),
      v_reason_code
    ) into v_transition_result;

    return v_transition_result
      || jsonb_build_object(
        'status', 'inventory_rejected',
        'missing_product_ids', to_jsonb(coalesce(v_missing, array[]::uuid[])),
        'short', v_short
      );
  end if;

  update commerce_runtime.inventory as inv
  set available = inv.available - alloc.qty,
      reserved = inv.reserved + alloc.qty,
      version = inv.version + 1,
      updated_at = clock_timestamp()
  from (
    select unnest(v_agg_ids) as product_id, unnest(v_agg_qty) as qty
  ) as alloc
  where inv.account_id = p_account_id and inv.product_id = alloc.product_id;

  select commerce_runtime.transition_order(
    p_account_id, p_order_id, p_expected_state_version, 'inventory_reserved',
    p_actor_type, p_actor_id, p_correlation_id,
    jsonb_build_object(
      'reserved_items', (
        select jsonb_agg(jsonb_build_object('product_id', pid, 'quantity', qty))
        from unnest(v_agg_ids, v_agg_qty) as t(pid, qty)
      )
    ),
    null
  ) into v_transition_result;

  return v_transition_result
    || jsonb_build_object('reserved_item_count', array_length(v_agg_ids, 1));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.claim_order_outbox_events / finish_order_outbox_event — leased Kafka publish
-- claim (ADR 004 §5.4). Claim never holds a lock while a worker talks to Kafka: it returns the
-- claimed batch and the worker publishes and reports back via finish in a separate transaction.
--
-- Claim is a single atomic CTE (SELECT ... FOR UPDATE SKIP LOCKED feeding an UPDATE ... FROM), not
-- a per-row PL/pgSQL loop, so the candidate scan and the claim mutation are one statement. It also
-- self-heals a lease that expired on an event's FINAL attempt: such a row previously matched
-- neither the claimable-candidate predicate (attempt_count < max_attempts excludes it) nor any
-- sweep job, so it stayed 'processing' with a dead lease forever. Claim now dead-letters those rows
-- itself, in the same statement, every time it runs — but only up to p_limit of them per call
-- (exhausted_candidates is its own bounded, deterministically-ordered, FOR UPDATE SKIP LOCKED scan),
-- so a large outage backlog of exhausted leases cannot turn one claim call into an unbounded
-- transaction that every concurrent claimer then contends on.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.claim_order_outbox_events(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 20
)
returns table (
  account_id uuid,
  outbox_event_id uuid,
  order_id uuid,
  event_type text,
  event_version text,
  schema_version text,
  payload jsonb,
  dedupe_key text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid outbox lease duration';
  end if;
  if p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid outbox claim limit';
  end if;

  return query
  with exhausted_candidates as (
    -- Bounded scan for exhausted, expired processing rows: same lease-exhaustion predicate the
    -- dead-lettering below relies on, but capped to p_limit rows in deterministic order under
    -- FOR UPDATE SKIP LOCKED, so a large outage backlog dead-letters at most p_limit rows per claim
    -- call instead of every exhausted row in the table in one unbounded transaction.
    select event.account_id, event.id
    from commerce_runtime.order_outbox_events as event
    where event.status = 'processing'
      and event.lease_until <= clock_timestamp()
      and event.attempt_count >= event.max_attempts
    order by event.lease_until, event.created_at, event.id
    for update skip locked
    limit p_limit
  ),
  dead_lettered as (
    -- Self-heal: an event whose lease expired on its last attempt is exhausted and unreclaimable
    -- by the candidates CTE below (attempt_count < max_attempts excludes it) — without this it
    -- would stay 'processing' with a dead lease forever. Dead-letter it here instead, clearing the
    -- lease so it stops looking like a live claim. Scoped to exhausted_candidates above, so this
    -- UPDATE only ever touches the bounded set just locked, never the full exhausted backlog.
    update commerce_runtime.order_outbox_events as event
    set status = 'dead_letter',
        claim_token = null,
        lease_holder = null,
        lease_until = null,
        next_attempt_at = null,
        last_error_code = 'LEASE_EXHAUSTED',
        sanitized_error_message = 'Outbox lease expired after exhausting max_attempts',
        updated_at = clock_timestamp()
    from exhausted_candidates
    where event.account_id = exhausted_candidates.account_id and event.id = exhausted_candidates.id
    returning event.id
  ),
  candidates as (
    -- Never-claimed pending rows, retry_scheduled rows past their backoff, and processing rows
    -- whose lease already expired but still have attempts left (an abandoned lease is reclaimable
    -- here, no separate sweep job needed).
    select event.account_id, event.id
    from commerce_runtime.order_outbox_events as event
    where event.attempt_count < event.max_attempts
      and event.id <> all (array(select dead_lettered.id from dead_lettered))
      and (
        event.status = 'pending'
        or (event.status = 'retry_scheduled' and event.next_attempt_at <= clock_timestamp())
        or (event.status = 'processing' and event.lease_until <= clock_timestamp())
      )
    order by coalesce(event.next_attempt_at, event.created_at), event.created_at, event.id
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update commerce_runtime.order_outbox_events as event
    set status = 'processing',
        claim_token = gen_random_uuid(),
        lease_holder = p_worker_id,
        lease_until = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds),
        lease_epoch = event.lease_epoch + 1,
        attempt_count = event.attempt_count + 1,
        next_attempt_at = null,
        updated_at = clock_timestamp()
    from candidates
    where event.account_id = candidates.account_id and event.id = candidates.id
    returning event.account_id, event.id as outbox_event_id, event.order_id, event.event_type,
      event.event_version, event.schema_version, event.payload, event.dedupe_key,
      event.claim_token, event.lease_epoch, event.lease_until, event.attempt_count
  )
  select account_id, outbox_event_id, order_id, event_type, event_version, schema_version,
    payload, dedupe_key, claim_token, lease_epoch, lease_until, attempt_count
  from claimed;
end
$$;

create function commerce_runtime.finish_order_outbox_event(
  p_account_id uuid,
  p_outbox_event_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_result_status text,
  p_worker_id text,
  p_next_attempt_at timestamptz default null,
  p_error_code text default null,
  p_sanitized_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event commerce_runtime.order_outbox_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text := p_result_status;
  v_next_attempt_at timestamptz := p_next_attempt_at;
begin
  -- 'failed' is not a status the order_outbox_events_status_check CHECK constraint permits — the
  -- table's explicit lifecycle is pending/processing/retry_scheduled/published/dead_letter, and a
  -- worker-observed publish failure is always translated by the caller into either
  -- 'retry_scheduled' (more attempts left) or 'dead_letter' (attempt budget exhausted), never a
  -- bare 'failed' the table itself would reject.
  if p_result_status not in ('published', 'retry_scheduled', 'dead_letter') then
    raise exception using errcode = '22023', message = 'invalid outbox result status';
  end if;
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_result_status in ('retry_scheduled', 'dead_letter') and p_error_code is null then
    raise exception using errcode = '22023', message = 'outbox retry/dead-letter requires error code';
  end if;

  select event.* into v_event
  from commerce_runtime.order_outbox_events as event
  where event.account_id = p_account_id and event.id = p_outbox_event_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'outbox event not found';
  end if;

  -- Fencing: a worker whose lease already expired (and was reclaimed by another worker) is
  -- rejected even if it eventually calls finish, so two workers can never both believe they
  -- published the same event. p_worker_id must also match the current lease_holder, not just the
  -- token/epoch/expiry — a worker id mismatch under an otherwise-valid token would mean a worker
  -- is reporting on a lease it never actually held.
  if v_event.status <> 'processing'
    or v_event.lease_epoch <> p_expected_epoch
    or v_event.claim_token is distinct from p_claim_token
    or v_event.lease_holder <> p_worker_id
    or v_event.lease_until <= v_now then
    raise exception using errcode = '55000', message = 'stale or invalid outbox lease';
  end if;

  if v_status = 'retry_scheduled' then
    -- Bounded exponential backoff regardless of caller input; once the attempt budget is
    -- exhausted this is silently upgraded to dead_letter instead of retrying forever.
    if v_event.attempt_count >= v_event.max_attempts then
      v_status := 'dead_letter';
      v_next_attempt_at := null;
    else
      if v_next_attempt_at is null then
        v_next_attempt_at := v_now + pg_catalog.make_interval(
          secs => least(3600.0, power(2::double precision, v_event.attempt_count::double precision))::int
        );
      end if;
      if v_next_attempt_at < v_now then
        v_next_attempt_at := v_now;
      end if;
      if v_next_attempt_at > v_now + interval '24 hours' then
        v_next_attempt_at := v_now + interval '24 hours';
      end if;
    end if;
  else
    v_next_attempt_at := null;
  end if;

  update commerce_runtime.order_outbox_events as event
  set status = v_status,
      next_attempt_at = v_next_attempt_at,
      claim_token = null,
      lease_holder = null,
      lease_until = null,
      published_at = case when v_status = 'published' then v_now else null end,
      last_error_code = p_error_code,
      sanitized_error_message = p_sanitized_error_message,
      updated_at = v_now
  where event.account_id = p_account_id and event.id = p_outbox_event_id;

  return jsonb_build_object(
    'status', v_status,
    'outbox_event_id', p_outbox_event_id,
    'next_attempt_at', v_next_attempt_at
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.consume_order_event — atomic consumer-side inbox dedupe + business mutation
-- (ADR 004 §5.5). Dedupe insert and the resulting transition run in the same transaction: a
-- conflict short-circuits with no mutation, and a mutation failure rolls back the dedupe insert
-- too, so a message is only ever marked consumed once its effect actually committed. This does
-- not and cannot claim exactly-once delivery — only exactly-once effect application per delivery.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.consume_order_event(
  p_account_id uuid,
  p_source_topic text,
  p_external_message_id text,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_inbox_id uuid;
  v_result jsonb;
begin
  if p_source_topic is null or char_length(p_source_topic) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid source topic';
  end if;
  if p_external_message_id is null or char_length(p_external_message_id) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'invalid external message id';
  end if;

  v_hash := commerce_runtime.sha256_text(p_external_message_id);

  insert into commerce_runtime.consumer_inbox (
    account_id, source_topic, external_message_id, external_message_id_hash,
    order_id, correlation_id
  ) values (
    p_account_id, p_source_topic, p_external_message_id, v_hash,
    p_order_id, p_correlation_id
  )
  on conflict (account_id, source_topic, external_message_id_hash) do nothing
  returning id into v_inbox_id;

  if v_inbox_id is null then
    return jsonb_build_object(
      'status', 'duplicate_ignored', 'order_id', p_order_id, 'idempotent_replay', true
    );
  end if;

  select commerce_runtime.transition_order(
    p_account_id, p_order_id, p_expected_state_version, p_to_state,
    p_actor_type, p_actor_id, p_correlation_id, p_transition_payload, p_reason_code
  ) into v_result;

  return v_result;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: service_role only, everywhere.
-- ---------------------------------------------------------------------------------------------

revoke all on function commerce_runtime.create_order(
  uuid, text, text, bigint, text, jsonb, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.claim_order_outbox_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function commerce_runtime.finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function commerce_runtime.create_order(
  uuid, text, text, bigint, text, jsonb, text
) to service_role;
grant execute on function commerce_runtime.transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;
grant execute on function commerce_runtime.reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) to service_role;
grant execute on function commerce_runtime.claim_order_outbox_events(text, integer, integer)
  to service_role;
grant execute on function commerce_runtime.finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) to service_role;
grant execute on function commerce_runtime.consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;

comment on function commerce_runtime.create_order(uuid, text, text, bigint, text, jsonb, text) is
  'Atomic idempotent order creation: order + birth transition + domain outbox event in one transaction.';
comment on function commerce_runtime.transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) is 'Fenced FSM transition: expected state_version, FK-enforced transition legality, outbox event.';
comment on function commerce_runtime.reserve_inventory(uuid, uuid, bigint, jsonb, text, text, text) is
  'All-or-nothing multi-SKU reservation: deterministic lock order, then created -> inventory_reserved '
  'on success or created -> inventory_rejected on missing/insufficient stock.';
comment on function commerce_runtime.claim_order_outbox_events(text, integer, integer) is
  'Single atomic CTE claim (SKIP LOCKED + UPDATE ... FROM), self-dead-lettering exhausted expired leases.';
comment on function commerce_runtime.finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) is 'Fenced settlement: claim_token + lease_epoch + unexpired lease required; bounded backoff, auto dead-letter.';
comment on function commerce_runtime.consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) is 'Atomic consumer-inbox dedupe + FSM mutation; no exactly-once delivery claim, only effect application.';

-- ---------------------------------------------------------------------------------------------
-- public.commerce_* — stable RPC-exposure wrappers (ADR 004 §5.6). Supabase/PostgREST only exposes
-- the schemas named in the project's `db.schemas` config, which is `public` (and `graphql_public`)
-- by default and does not include `commerce_runtime`; a function that exists only in
-- `commerce_runtime`, however carefully it is written, is unreachable through a normal
-- `supabase.rpc(...)` call or any other PostgREST client. These wrappers are thin pass-throughs —
-- same argument shapes, no added logic — that live in `public` purely so the closed schema's RPCs
-- have a callable public contract. Each is `security definer` with `set search_path = ''` exactly
-- like its `commerce_runtime` counterpart, and is revoked from `public`/`anon`/`authenticated` and
-- granted only to `service_role`, so exposure through PostgREST does not loosen the closed-schema
-- access model: only service_role callers (server-side, e.g. an Edge Function) can invoke either
-- the wrapper or the function it wraps.
-- ---------------------------------------------------------------------------------------------

create function public.commerce_create_order(
  p_account_id uuid,
  p_idempotency_key text,
  p_currency text,
  p_total_amount_minor bigint,
  p_customer_ref text default null,
  p_order_payload jsonb default '{}'::jsonb,
  p_correlation_id text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.create_order(
    p_account_id, p_idempotency_key, p_currency, p_total_amount_minor,
    p_customer_ref, p_order_payload, p_correlation_id
  )
$$;

create function public.commerce_transition_order(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.transition_order(
    p_account_id, p_order_id, p_expected_state_version, p_to_state,
    p_actor_type, p_actor_id, p_correlation_id, p_transition_payload, p_reason_code
  )
$$;

create function public.commerce_reserve_inventory(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_items jsonb,
  p_actor_type text default 'system',
  p_actor_id text default 'reserve_inventory',
  p_correlation_id text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.reserve_inventory(
    p_account_id, p_order_id, p_expected_state_version, p_items,
    p_actor_type, p_actor_id, p_correlation_id
  )
$$;

create function public.commerce_claim_order_outbox_events(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 20
)
returns table (
  account_id uuid,
  outbox_event_id uuid,
  order_id uuid,
  event_type text,
  event_version text,
  schema_version text,
  payload jsonb,
  dedupe_key text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer
)
language sql
security definer
set search_path = ''
as $$
  select * from commerce_runtime.claim_order_outbox_events(
    p_worker_id, p_lease_duration_seconds, p_limit
  )
$$;

create function public.commerce_finish_order_outbox_event(
  p_account_id uuid,
  p_outbox_event_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_result_status text,
  p_worker_id text,
  p_next_attempt_at timestamptz default null,
  p_error_code text default null,
  p_sanitized_error_message text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.finish_order_outbox_event(
    p_account_id, p_outbox_event_id, p_expected_epoch, p_claim_token, p_result_status,
    p_worker_id, p_next_attempt_at, p_error_code, p_sanitized_error_message
  )
$$;

create function public.commerce_consume_order_event(
  p_account_id uuid,
  p_source_topic text,
  p_external_message_id text,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.consume_order_event(
    p_account_id, p_source_topic, p_external_message_id, p_order_id, p_expected_state_version,
    p_to_state, p_actor_type, p_actor_id, p_correlation_id, p_transition_payload, p_reason_code
  )
$$;

revoke all on function public.commerce_create_order(
  uuid, text, text, bigint, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.commerce_transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.commerce_reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) from public, anon, authenticated;
revoke all on function public.commerce_claim_order_outbox_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.commerce_finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.commerce_consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.commerce_create_order(
  uuid, text, text, bigint, text, jsonb, text
) to service_role;
grant execute on function public.commerce_transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;
grant execute on function public.commerce_reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) to service_role;
grant execute on function public.commerce_claim_order_outbox_events(text, integer, integer)
  to service_role;
grant execute on function public.commerce_finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) to service_role;
grant execute on function public.commerce_consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;

comment on function public.commerce_create_order(uuid, text, text, bigint, text, jsonb, text) is
  'Public RPC-exposure wrapper for commerce_runtime.create_order (service_role only).';
comment on function public.commerce_transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) is 'Public RPC-exposure wrapper for commerce_runtime.transition_order (service_role only).';
comment on function public.commerce_reserve_inventory(uuid, uuid, bigint, jsonb, text, text, text) is
  'Public RPC-exposure wrapper for commerce_runtime.reserve_inventory (service_role only).';
comment on function public.commerce_claim_order_outbox_events(text, integer, integer) is
  'Public RPC-exposure wrapper for commerce_runtime.claim_order_outbox_events (service_role only).';
comment on function public.commerce_finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) is 'Public RPC-exposure wrapper for commerce_runtime.finish_order_outbox_event (service_role only).';
comment on function public.commerce_consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) is 'Public RPC-exposure wrapper for commerce_runtime.consume_order_event (service_role only).';

-- ─── 20260826120000_durable_a2a_inbox_outbox.sql ─────────────────────────────────────────────
-- ADR 001/002 extension: tenant-safe durable delivery for compact agent-to-agent messages.

create table runtime.a2a_outbox_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  message_id uuid not null,
  protocol_version text not null default '1.0',
  from_agent_id text not null,
  to_agent_id text not null,
  intent text not null,
  sender_lease_epoch bigint not null,
  message jsonb not null,
  message_hash text not null,
  status text not null default 'pending',
  lease_holder text,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint a2a_outbox_account_id_id_key unique (account_id, id),
  constraint a2a_outbox_message_key unique (account_id, workflow_id, message_id),
  constraint a2a_outbox_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint a2a_outbox_protocol_check check (protocol_version = '1.0'),
  constraint a2a_outbox_agent_check check (
    from_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and to_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and from_agent_id <> to_agent_id
  ),
  constraint a2a_outbox_intent_check check (intent in ('handoff', 'query', 'approval_request', 'result', 'error')),
  constraint a2a_outbox_sender_epoch_check check (sender_lease_epoch > 0),
  constraint a2a_outbox_message_uuidv7_check check (substring(message_id::text from 15 for 1) = '7'),
  constraint a2a_outbox_message_object_check check (jsonb_typeof(message) = 'object'),
  constraint a2a_outbox_message_size_check check (octet_length(message::text) <= 16384),
  constraint a2a_outbox_message_hash_check check (message_hash ~ '^[0-9a-f]{64}$'),
  constraint a2a_outbox_no_secret_keys_check check (
    message::text !~* '"(authorization|cookie|password|passwd|secret|api_?key|access_?token|refresh_?token|service_?role(_?key)?|private_?key)"[[:space:]]*:'
  ),
  constraint a2a_outbox_message_identity_check check (
    message ->> 'version' = protocol_version
    and message ->> 'account_id' = account_id::text
    and message ->> 'workflow_id' = workflow_id::text
    and message ->> 'message_id' = message_id::text
    and message ->> 'from_agent_id' = from_agent_id
    and message ->> 'to_agent_id' = to_agent_id
    and message ->> 'intent' = intent
    and (message ->> 'sender_lease_epoch')::bigint = sender_lease_epoch
  ),
  constraint a2a_outbox_status_check check (status in ('pending', 'delivering', 'delivered', 'failed')),
  constraint a2a_outbox_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts
  ),
  constraint a2a_outbox_lease_epoch_check check (lease_epoch >= 0),
  constraint a2a_outbox_lease_integrity_check check (
    (status = 'delivering' and lease_holder is not null and lease_until is not null and claim_token is not null)
    or (status <> 'delivering' and lease_holder is null and lease_until is null and claim_token is null)
  ),
  constraint a2a_outbox_delivery_integrity_check check (
    (status = 'delivered' and delivered_at is not null and next_attempt_at is null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  constraint a2a_outbox_retry_integrity_check check (
    (status = 'pending' and attempt_count > 0 and next_attempt_at is not null)
    or (status = 'pending' and attempt_count = 0 and next_attempt_at is null)
    or status <> 'pending'
  ),
  constraint a2a_outbox_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create index a2a_outbox_claim_idx
  on runtime.a2a_outbox_messages (coalesce(next_attempt_at, created_at), created_at, id)
  where status in ('pending', 'delivering');

create table runtime.a2a_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  workflow_id uuid not null,
  message_id uuid not null,
  protocol_version text not null default '1.0',
  from_agent_id text not null,
  to_agent_id text not null,
  intent text not null,
  sender_lease_epoch bigint not null,
  message jsonb not null,
  message_hash text not null,
  status text not null default 'delivered',
  lease_holder text,
  lease_until timestamptz,
  claim_token uuid,
  lease_epoch bigint not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  processed_at timestamptz,
  last_error_code text,
  received_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint a2a_inbox_account_id_id_key unique (account_id, id),
  constraint a2a_inbox_message_key unique (account_id, workflow_id, message_id),
  constraint a2a_inbox_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint a2a_inbox_protocol_check check (protocol_version = '1.0'),
  constraint a2a_inbox_agent_check check (
    from_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and to_agent_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    and from_agent_id <> to_agent_id
  ),
  constraint a2a_inbox_intent_check check (intent in ('handoff', 'query', 'approval_request', 'result', 'error')),
  constraint a2a_inbox_sender_epoch_check check (sender_lease_epoch > 0),
  constraint a2a_inbox_message_uuidv7_check check (substring(message_id::text from 15 for 1) = '7'),
  constraint a2a_inbox_message_object_check check (jsonb_typeof(message) = 'object'),
  constraint a2a_inbox_message_size_check check (octet_length(message::text) <= 16384),
  constraint a2a_inbox_message_hash_check check (message_hash ~ '^[0-9a-f]{64}$'),
  constraint a2a_inbox_no_secret_keys_check check (
    message::text !~* '"(authorization|cookie|password|passwd|secret|api_?key|access_?token|refresh_?token|service_?role(_?key)?|private_?key)"[[:space:]]*:'
  ),
  constraint a2a_inbox_message_identity_check check (
    message ->> 'version' = protocol_version
    and message ->> 'account_id' = account_id::text
    and message ->> 'workflow_id' = workflow_id::text
    and message ->> 'message_id' = message_id::text
    and message ->> 'from_agent_id' = from_agent_id
    and message ->> 'to_agent_id' = to_agent_id
    and message ->> 'intent' = intent
    and (message ->> 'sender_lease_epoch')::bigint = sender_lease_epoch
  ),
  constraint a2a_inbox_status_check check (status in ('delivered', 'processing', 'processed', 'failed')),
  constraint a2a_inbox_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 20 and attempt_count <= max_attempts
  ),
  constraint a2a_inbox_lease_epoch_check check (lease_epoch >= 0),
  constraint a2a_inbox_lease_integrity_check check (
    (status = 'processing' and lease_holder is not null and lease_until is not null and claim_token is not null)
    or (status <> 'processing' and lease_holder is null and lease_until is null and claim_token is null)
  ),
  constraint a2a_inbox_processed_integrity_check check (
    (status = 'processed' and processed_at is not null)
    or (status <> 'processed' and processed_at is null)
  ),
  constraint a2a_inbox_error_code_check check (
    last_error_code is null or last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  )
);

create index a2a_inbox_claim_idx
  on runtime.a2a_inbox_messages (received_at, id)
  where status in ('delivered', 'processing');

alter table runtime.a2a_outbox_messages enable row level security;
alter table runtime.a2a_inbox_messages enable row level security;
revoke all on runtime.a2a_outbox_messages, runtime.a2a_inbox_messages from public, anon, authenticated;

create function public.runtime_enqueue_a2a_message(
  p_account_id uuid,
  p_workflow_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_message jsonb
)
returns table (enqueue_status text, outbox_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_message_id uuid;
  v_hash text;
  v_outbox_id uuid;
  v_existing_hash text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' or octet_length(p_message::text) > 16384 then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;

  select run.* into v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if not found
    or v_run.current_state <> 'running'
    or v_run.lease_epoch <> p_expected_epoch
    or v_run.claim_token <> p_claim_token
    or v_run.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'workflow fence rejected';
  end if;

  begin
    v_message_id := (p_message ->> 'message_id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end;

  if p_message ->> 'version' <> '1.0'
    or p_message ->> 'account_id' <> p_account_id::text
    or p_message ->> 'workflow_id' <> p_workflow_id::text
    or (p_message ->> 'sender_lease_epoch')::bigint <> p_expected_epoch then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;

  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_message::text, 'UTF8'), 'sha256'), 'hex');

  insert into runtime.a2a_outbox_messages (
    account_id, workflow_id, message_id, protocol_version, from_agent_id, to_agent_id,
    intent, sender_lease_epoch, message, message_hash
  ) values (
    p_account_id, p_workflow_id, v_message_id, p_message ->> 'version',
    p_message ->> 'from_agent_id', p_message ->> 'to_agent_id', p_message ->> 'intent',
    p_expected_epoch, p_message, v_hash
  )
  on conflict on constraint a2a_outbox_message_key do nothing
  returning id into v_outbox_id;

  if v_outbox_id is not null then
    return query select 'created'::text, v_outbox_id, v_message_id;
    return;
  end if;

  select item.id, item.message_hash into v_outbox_id, v_existing_hash
  from runtime.a2a_outbox_messages as item
  where item.account_id = p_account_id
    and item.workflow_id = p_workflow_id
    and item.message_id = v_message_id;

  if v_existing_hash <> v_hash then
    raise exception using errcode = '23505', message = 'a2a idempotency collision';
  end if;
  return query select 'duplicate'::text, v_outbox_id, v_message_id;
end;
$$;

create function public.runtime_claim_a2a_outbox(
  p_worker_id text,
  p_lease_duration_seconds integer default 60,
  p_limit integer default 10
)
returns table (
  account_id uuid, outbox_id uuid, workflow_id uuid, message_id uuid, message jsonb,
  claim_token uuid, lease_epoch bigint, lease_until timestamptz, attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160
    or p_lease_duration_seconds not between 5 and 600
    or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid a2a claim parameters';
  end if;
  if exists (
    select 1 from runtime.system_controls as controls
    where controls.singleton and (controls.kill_switch_active or controls.claims_paused)
  ) then return; end if;

  return query
  with candidates as (
    select item.id
    from runtime.a2a_outbox_messages as item
    where item.attempt_count < item.max_attempts
      and (
        (item.status = 'pending' and (item.next_attempt_at is null or item.next_attempt_at <= clock_timestamp()))
        or (item.status = 'delivering' and item.lease_until <= clock_timestamp())
      )
    order by coalesce(item.next_attempt_at, item.created_at), item.created_at, item.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update runtime.a2a_outbox_messages as item
    set status = 'delivering',
        lease_holder = p_worker_id,
        lease_until = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds),
        claim_token = gen_random_uuid(),
        lease_epoch = item.lease_epoch + 1,
        attempt_count = item.attempt_count + 1,
        next_attempt_at = null,
        last_error_code = null,
        updated_at = clock_timestamp()
    from candidates
    where item.id = candidates.id
    returning item.*
  )
  select claimed.account_id, claimed.id, claimed.workflow_id, claimed.message_id, claimed.message,
         claimed.claim_token, claimed.lease_epoch, claimed.lease_until, claimed.attempt_count
  from claimed;
end;
$$;

create function public.runtime_finish_a2a_delivery(
  p_account_id uuid,
  p_outbox_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_delivered boolean,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item runtime.a2a_outbox_messages%rowtype;
  v_status text;
begin
  select item.* into v_item
  from runtime.a2a_outbox_messages as item
  where item.account_id = p_account_id and item.id = p_outbox_id
  for update;
  if not found or v_item.status <> 'delivering' or v_item.lease_epoch <> p_expected_epoch
    or v_item.claim_token <> p_claim_token or v_item.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'a2a delivery fence rejected';
  end if;
  if not p_delivered and (p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception using errcode = '22023', message = 'invalid a2a delivery result';
  end if;

  v_status := case when p_delivered then 'delivered'
    when v_item.attempt_count >= v_item.max_attempts then 'failed' else 'pending' end;
  update runtime.a2a_outbox_messages as item
  set status = v_status,
      lease_holder = null, lease_until = null, claim_token = null,
      delivered_at = case when p_delivered then clock_timestamp() else null end,
      next_attempt_at = case when v_status = 'pending'
        then clock_timestamp() + pg_catalog.make_interval(secs => least(300, (2 ^ least(v_item.attempt_count, 8))::integer))
        else null end,
      last_error_code = case when p_delivered then null else p_error_code end,
      updated_at = clock_timestamp()
  where item.account_id = p_account_id and item.id = p_outbox_id;
  return v_status;
end;
$$;

create function public.runtime_receive_a2a_message(p_message jsonb)
returns table (receive_status text, inbox_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_workflow_id uuid;
  v_message_id uuid;
  v_hash text;
  v_inbox_id uuid;
  v_existing_hash text;
begin
  if p_message is null or jsonb_typeof(p_message) <> 'object' or octet_length(p_message::text) > 16384 then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;
  begin
    v_account_id := (p_message ->> 'account_id')::uuid;
    v_workflow_id := (p_message ->> 'workflow_id')::uuid;
    v_message_id := (p_message ->> 'message_id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end;
  if p_message ->> 'version' <> '1.0' then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;
  if not exists (
    select 1 from runtime.workflow_runs as run
    where run.account_id = v_account_id and run.id = v_workflow_id
  ) then
    raise exception using errcode = '22023', message = 'invalid a2a message';
  end if;
  v_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p_message::text, 'UTF8'), 'sha256'), 'hex');
  if not exists (
    select 1 from runtime.a2a_outbox_messages as sent
    where sent.account_id = v_account_id
      and sent.workflow_id = v_workflow_id
      and sent.message_id = v_message_id
      and sent.message_hash = v_hash
      and sent.sender_lease_epoch = (p_message ->> 'sender_lease_epoch')::bigint
      and sent.status in ('delivering', 'delivered')
  ) then
    raise exception using errcode = '55000', message = 'a2a source proof rejected';
  end if;
  insert into runtime.a2a_inbox_messages (
    account_id, workflow_id, message_id, protocol_version, from_agent_id, to_agent_id,
    intent, sender_lease_epoch, message, message_hash
  ) values (
    v_account_id, v_workflow_id, v_message_id, p_message ->> 'version',
    p_message ->> 'from_agent_id', p_message ->> 'to_agent_id', p_message ->> 'intent',
    (p_message ->> 'sender_lease_epoch')::bigint, p_message, v_hash
  )
  on conflict on constraint a2a_inbox_message_key do nothing
  returning id into v_inbox_id;
  if v_inbox_id is not null then
    return query select 'created'::text, v_inbox_id, v_message_id;
    return;
  end if;
  select item.id, item.message_hash into v_inbox_id, v_existing_hash
  from runtime.a2a_inbox_messages as item
  where item.account_id = v_account_id and item.workflow_id = v_workflow_id and item.message_id = v_message_id;
  if v_existing_hash <> v_hash then
    raise exception using errcode = '23505', message = 'a2a idempotency collision';
  end if;
  return query select 'duplicate'::text, v_inbox_id, v_message_id;
end;
$$;

create function public.runtime_claim_a2a_inbox(
  p_worker_id text,
  p_to_agent_id text,
  p_lease_duration_seconds integer default 60,
  p_limit integer default 10
)
returns table (
  account_id uuid, inbox_id uuid, workflow_id uuid, message_id uuid, message jsonb,
  claim_token uuid, lease_epoch bigint, lease_until timestamptz, attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160
    or p_to_agent_id is null or p_to_agent_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_lease_duration_seconds not between 5 and 600
    or p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid a2a claim parameters';
  end if;
  if exists (
    select 1 from runtime.system_controls as controls
    where controls.singleton and (controls.kill_switch_active or controls.claims_paused)
  ) then return; end if;
  return query
  with candidates as (
    select item.id
    from runtime.a2a_inbox_messages as item
    where item.to_agent_id = p_to_agent_id
      and item.attempt_count < item.max_attempts
      and (item.status = 'delivered' or (item.status = 'processing' and item.lease_until <= clock_timestamp()))
    order by item.received_at, item.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update runtime.a2a_inbox_messages as item
    set status = 'processing', lease_holder = p_worker_id,
        lease_until = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds),
        claim_token = gen_random_uuid(), lease_epoch = item.lease_epoch + 1,
        attempt_count = item.attempt_count + 1, last_error_code = null, updated_at = clock_timestamp()
    from candidates where item.id = candidates.id
    returning item.*
  )
  select claimed.account_id, claimed.id, claimed.workflow_id, claimed.message_id, claimed.message,
         claimed.claim_token, claimed.lease_epoch, claimed.lease_until, claimed.attempt_count
  from claimed;
end;
$$;

create function public.runtime_finish_a2a_processing(
  p_account_id uuid,
  p_inbox_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_processed boolean,
  p_error_code text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item runtime.a2a_inbox_messages%rowtype;
  v_status text;
begin
  select item.* into v_item from runtime.a2a_inbox_messages as item
  where item.account_id = p_account_id and item.id = p_inbox_id for update;
  if not found or v_item.status <> 'processing' or v_item.lease_epoch <> p_expected_epoch
    or v_item.claim_token <> p_claim_token or v_item.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'a2a processing fence rejected';
  end if;
  if not p_processed and (p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$') then
    raise exception using errcode = '22023', message = 'invalid a2a processing result';
  end if;
  v_status := case when p_processed then 'processed'
    when v_item.attempt_count >= v_item.max_attempts then 'failed' else 'delivered' end;
  update runtime.a2a_inbox_messages as item
  set status = v_status, lease_holder = null, lease_until = null, claim_token = null,
      processed_at = case when p_processed then clock_timestamp() else null end,
      last_error_code = case when p_processed then null else p_error_code end,
      updated_at = clock_timestamp()
  where item.account_id = p_account_id and item.id = p_inbox_id;
  return v_status;
end;
$$;

revoke all on function public.runtime_enqueue_a2a_message(uuid, uuid, bigint, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.runtime_claim_a2a_outbox(text, integer, integer) from public, anon, authenticated;
revoke all on function public.runtime_finish_a2a_delivery(uuid, uuid, bigint, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.runtime_receive_a2a_message(jsonb) from public, anon, authenticated;
revoke all on function public.runtime_claim_a2a_inbox(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.runtime_finish_a2a_processing(uuid, uuid, bigint, uuid, boolean, text) from public, anon, authenticated;

grant execute on function public.runtime_enqueue_a2a_message(uuid, uuid, bigint, uuid, jsonb) to service_role;
grant execute on function public.runtime_claim_a2a_outbox(text, integer, integer) to service_role;
grant execute on function public.runtime_finish_a2a_delivery(uuid, uuid, bigint, uuid, boolean, text) to service_role;
grant execute on function public.runtime_receive_a2a_message(jsonb) to service_role;
grant execute on function public.runtime_claim_a2a_inbox(text, text, integer, integer) to service_role;
grant execute on function public.runtime_finish_a2a_processing(uuid, uuid, bigint, uuid, boolean, text) to service_role;

comment on table runtime.a2a_outbox_messages is 'Lease-fenced durable A2A delivery queue; browser roles have no access.';
comment on table runtime.a2a_inbox_messages is 'Idempotent durable A2A receive queue; browser roles have no access.';

-- ─── 20260826130000_nemo_forge_runtime.sql ───────────────────────────────────────────────────
-- ADR 004 / Nemo Forge Stage 1: durable project and execution state.
--
-- This migration intentionally keeps the runtime schema closed. Browser clients
-- must use scoped SECURITY DEFINER RPCs added in the next stage; they must never
-- subscribe to or mutate these tables directly.

create table runtime.skill_definitions (
  skill_id text primary key,
  display_name text not null,
  description text not null,
  allowed_step_types text[] not null,
  allowed_compute_profiles text[] not null,
  risk_class text not null default 'low',
  version integer not null default 1,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint skill_definitions_id_check check (
    char_length(skill_id) between 1 and 120
    and skill_id ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint skill_definitions_name_check check (char_length(display_name) between 1 and 160),
  constraint skill_definitions_description_check check (char_length(description) between 1 and 2048),
  constraint skill_definitions_step_types_check check (
    cardinality(allowed_step_types) between 1 and 6
    and allowed_step_types <@ array[
      'research', 'documents', 'media', 'quality_check', 'approval', 'publish'
    ]::text[]
  ),
  constraint skill_definitions_profiles_check check (
    cardinality(allowed_compute_profiles) between 1 and 4
    and allowed_compute_profiles <@ array[
      'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU'
    ]::text[]
  ),
  constraint skill_definitions_risk_check check (risk_class in ('low', 'medium', 'high')),
  constraint skill_definitions_version_check check (version between 1 and 1000000)
);

create function runtime.text_array_is_unique(p_values text[])
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.cardinality(p_values) = (
    select pg_catalog.count(distinct value)
    from pg_catalog.unnest(p_values) as valueset(value)
  )
$$;

alter table runtime.skill_definitions
  add constraint skill_definitions_step_types_unique_check check (
    array_position(allowed_step_types, null) is null
    and runtime.text_array_is_unique(allowed_step_types)
  ),
  add constraint skill_definitions_profiles_unique_check check (
    array_position(allowed_compute_profiles, null) is null
    and runtime.text_array_is_unique(allowed_compute_profiles)
  );

insert into runtime.skill_definitions (
  skill_id, display_name, description, allowed_step_types,
  allowed_compute_profiles, risk_class
) values
  ('evidence-research', 'Evidence research',
    'Collects bounded evidence and returns references rather than unsupported claims.',
    array['research'], array['PROFILE_A_WASI'], 'low'),
  ('document-authoring', 'Document authoring',
    'Compiles structured, self-contained documents in the document sandbox.',
    array['documents'], array['PROFILE_B_DOCS'], 'medium'),
  ('media-generation', 'Media generation',
    'Creates bounded media artifacts through verified media connectors and workers.',
    array['media'], array['PROFILE_C_BROWSER', 'PROFILE_D_GPU'], 'high'),
  ('grounding-quality-gate', 'Grounding quality gate',
    'Checks evidence, factual consistency, and policy constraints before approval.',
    array['quality_check'], array['PROFILE_A_WASI'], 'low'),
  ('human-approval', 'Human approval',
    'Pauses a plan until an authorized tenant operator records a decision.',
    array['approval'], array['PROFILE_A_WASI'], 'high'),
  ('approved-delivery', 'Approved delivery',
    'Queues an approved result for delivery without bypassing the runtime outbox.',
    array['publish'], array['PROFILE_A_WASI'], 'high');

create table runtime.projects (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  title text not null,
  raw_prompt text not null,
  budget_cap_usd numeric(14, 4) not null,
  status text not null default 'draft',
  plan_version text not null default '1.0',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_projects_account_id_id_key unique (account_id, id),
  constraint forge_projects_title_check check (char_length(title) between 1 and 160),
  constraint forge_projects_prompt_check check (
    char_length(raw_prompt) between 3 and 16384
    and octet_length(raw_prompt) <= 65536
  ),
  constraint forge_projects_budget_check check (budget_cap_usd between 0 and 1000000),
  constraint forge_projects_status_check check (status in (
    'draft', 'compiling', 'ready', 'running', 'paused', 'completed', 'failed', 'cancelled'
  )),
  constraint forge_projects_plan_version_check check (
    char_length(plan_version) between 1 and 32
    and plan_version ~ '^[0-9]+(\.[0-9]+){0,2}$'
  )
);

create table runtime.project_executions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  project_id uuid not null,
  workflow_id uuid,
  idempotency_key text not null,
  plan_snapshot jsonb not null,
  plan_hash text generated always as (runtime.sha256_jsonb(plan_snapshot)) stored,
  current_stage_index integer not null default 0,
  status text not null default 'queued',
  fencing_epoch bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_executions_account_id_id_key unique (account_id, id),
  constraint forge_executions_account_execution_id_key unique (account_id, project_id, id),
  constraint forge_executions_idempotency_key unique (account_id, project_id, idempotency_key),
  constraint forge_executions_project_fkey foreign key (account_id, project_id)
    references runtime.projects(account_id, id) on delete restrict,
  constraint forge_executions_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint forge_executions_idempotency_check check (
    char_length(idempotency_key) between 1 and 160
    and idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint forge_executions_plan_object_check check (jsonb_typeof(plan_snapshot) = 'object'),
  constraint forge_executions_plan_size_check check (octet_length(plan_snapshot::text) <= 262144),
  constraint forge_executions_plan_shape_check check (
    plan_snapshot->>'schemaVersion' = '1.0'
    and plan_snapshot->>'projectId' = project_id::text
    and jsonb_typeof(plan_snapshot->'steps') = 'array'
    and jsonb_array_length(plan_snapshot->'steps') between 1 and 32
    and (plan_snapshot->>'totalBudgetCapUsd')::numeric between 0 and 1000000
    and (plan_snapshot->>'estimatedCostUsd')::numeric between 0
      and (plan_snapshot->>'totalBudgetCapUsd')::numeric
  ),
  constraint forge_executions_stage_check check (
    current_stage_index >= 0
    and current_stage_index < jsonb_array_length(plan_snapshot->'steps')
  ),
  constraint forge_executions_status_check check (status in (
    'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'
  )),
  constraint forge_executions_fencing_check check (fencing_epoch >= 0)
);

create table runtime.execution_steps (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  execution_id uuid not null,
  step_index integer not null,
  title text not null,
  step_type text not null,
  status text not null default 'pending',
  assigned_skill_id text not null references runtime.skill_definitions(skill_id) on delete restrict,
  compute_profile text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  artifact_refs jsonb not null default '[]'::jsonb,
  cost_tokens bigint not null default 0,
  estimated_cost_usd numeric(14, 6) not null default 0,
  requires_approval boolean not null default false,
  claim_token uuid,
  lease_holder text,
  lease_until timestamptz,
  fencing_epoch bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_steps_account_id_id_key unique (account_id, id),
  constraint forge_steps_account_execution_id_key unique (account_id, execution_id, id),
  constraint forge_steps_order_key unique (account_id, execution_id, step_index),
  constraint forge_steps_execution_fkey foreign key (account_id, execution_id)
    references runtime.project_executions(account_id, id) on delete restrict,
  constraint forge_steps_index_check check (step_index between 0 and 31),
  constraint forge_steps_title_check check (char_length(title) between 1 and 160),
  constraint forge_steps_type_check check (step_type in (
    'research', 'documents', 'media', 'quality_check', 'approval', 'publish'
  )),
  constraint forge_steps_status_check check (status in (
    'pending', 'running', 'completed', 'waiting_approval', 'failed', 'cancelled', 'skipped'
  )),
  constraint forge_steps_profile_check check (compute_profile in (
    'PROFILE_A_WASI', 'PROFILE_B_DOCS', 'PROFILE_C_BROWSER', 'PROFILE_D_GPU'
  )),
  constraint forge_steps_evidence_array_check check (
    jsonb_typeof(evidence_refs) = 'array'
    and jsonb_array_length(evidence_refs) <= 64
    and octet_length(evidence_refs::text) <= 65536
  ),
  constraint forge_steps_artifact_array_check check (
    jsonb_typeof(artifact_refs) = 'array'
    and jsonb_array_length(artifact_refs) <= 64
    and octet_length(artifact_refs::text) <= 65536
  ),
  constraint forge_steps_cost_check check (
    cost_tokens >= 0 and estimated_cost_usd between 0 and 1000000
  ),
  constraint forge_steps_approval_check check (
    (step_type = 'approval' and requires_approval)
    or (step_type = 'publish' and requires_approval)
    or step_type not in ('approval', 'publish')
  ),
  constraint forge_steps_fencing_check check (fencing_epoch >= 0),
  constraint forge_steps_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint forge_steps_lease_integrity_check check (
    (status = 'running' and claim_token is not null and lease_holder is not null and lease_until is not null)
    or (status <> 'running' and claim_token is null and lease_holder is null and lease_until is null)
  )
);

create table runtime.execution_step_dependencies (
  account_id uuid not null,
  execution_id uuid not null,
  step_id uuid not null,
  depends_on_step_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (account_id, step_id, depends_on_step_id),
  constraint forge_step_dependencies_step_fkey
    foreign key (account_id, execution_id, step_id)
    references runtime.execution_steps(account_id, execution_id, id) on delete cascade,
  constraint forge_step_dependencies_parent_fkey
    foreign key (account_id, execution_id, depends_on_step_id)
    references runtime.execution_steps(account_id, execution_id, id) on delete restrict,
  constraint forge_step_dependencies_not_self_check check (step_id <> depends_on_step_id)
);

create table runtime.connector_capabilities (
  account_id uuid not null references public.accounts(id) on delete restrict,
  provider text not null,
  operations text[] not null,
  connection_type text not null,
  verified boolean not null default false,
  verified_at timestamptz,
  verification_ref text,
  models text[] not null default '{}'::text[],
  max_duration_seconds integer,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (account_id, provider),
  constraint forge_connector_provider_check check (
    char_length(provider) between 1 and 80
    and provider ~ '^[a-z0-9][a-z0-9_-]*$'
  ),
  constraint forge_connector_operations_check check (
    cardinality(operations) between 1 and 6
    and array_position(operations, null) is null
    and runtime.text_array_is_unique(operations)
    and operations <@ array['image', 'video', 'voice', 'avatar', 'document', 'research']::text[]
  ),
  constraint forge_connector_connection_check check (
    connection_type in ('api_key', 'oauth', 'mcp', 'local')
  ),
  constraint forge_connector_verification_check check (
    (verified and verified_at is not null and verification_ref is not null)
    or (not verified and verified_at is null and verification_ref is null)
  ),
  constraint forge_connector_verification_ref_check check (
    verification_ref is null or char_length(verification_ref) between 1 and 512
  ),
  constraint forge_connector_models_check check (
    cardinality(models) <= 100
    and array_position(models, null) is null
    and runtime.text_array_is_unique(models)
  ),
  constraint forge_connector_duration_check check (
    (max_duration_seconds is null)
    or ('video' = any(operations) and max_duration_seconds between 1 and 3600)
  )
);

create function runtime.touch_forge_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create function runtime.validate_forge_step()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_skill runtime.skill_definitions%rowtype;
begin
  select skill.* into strict v_skill
  from runtime.skill_definitions as skill
  where skill.skill_id = new.assigned_skill_id;

  if not v_skill.active then
    raise exception using errcode = '23514', message = 'assigned Forge skill is inactive';
  end if;
  if not (new.step_type = any(v_skill.allowed_step_types)) then
    raise exception using errcode = '23514', message = 'Forge skill does not allow this step type';
  end if;
  if not (new.compute_profile = any(v_skill.allowed_compute_profiles)) then
    raise exception using errcode = '23514', message = 'Forge skill does not allow this compute profile';
  end if;
  return new;
end;
$$;

create function runtime.protect_forge_execution_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.account_id is distinct from old.account_id
     or new.project_id is distinct from old.project_id
     or new.workflow_id is distinct from old.workflow_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.plan_snapshot is distinct from old.plan_snapshot then
    raise exception using errcode = '55000', message = 'Forge execution identity and plan snapshot are immutable';
  end if;
  return new;
end;
$$;

create trigger forge_skill_definitions_touch
before update on runtime.skill_definitions
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_projects_touch
before update on runtime.projects
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_project_executions_touch
before update on runtime.project_executions
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_project_executions_identity_immutable
before update on runtime.project_executions
for each row execute function runtime.protect_forge_execution_identity();

create trigger forge_execution_steps_touch
before update on runtime.execution_steps
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_execution_steps_validate
before insert or update of assigned_skill_id, step_type, compute_profile
on runtime.execution_steps
for each row execute function runtime.validate_forge_step();

create trigger forge_connector_capabilities_touch
before update on runtime.connector_capabilities
for each row execute function runtime.touch_forge_updated_at();

create index forge_projects_account_status_idx
  on runtime.projects (account_id, status, updated_at desc, id);
create index forge_executions_project_status_idx
  on runtime.project_executions (account_id, project_id, status, updated_at desc, id);
create index forge_executions_workflow_idx
  on runtime.project_executions (account_id, workflow_id)
  where workflow_id is not null;
create index forge_steps_ready_idx
  on runtime.execution_steps (account_id, execution_id, step_index, id)
  where status = 'pending';
create index forge_steps_expired_lease_idx
  on runtime.execution_steps (lease_until, account_id, id)
  where status = 'running';
create index forge_step_dependencies_execution_idx
  on runtime.execution_step_dependencies (account_id, execution_id, step_id);
create index forge_connector_verified_idx
  on runtime.connector_capabilities (account_id, provider)
  where verified;

alter table runtime.skill_definitions enable row level security;
alter table runtime.projects enable row level security;
alter table runtime.project_executions enable row level security;
alter table runtime.execution_steps enable row level security;
alter table runtime.execution_step_dependencies enable row level security;
alter table runtime.connector_capabilities enable row level security;

revoke all on table runtime.skill_definitions from public, anon, authenticated;
revoke all on table runtime.projects from public, anon, authenticated;
revoke all on table runtime.project_executions from public, anon, authenticated;
revoke all on table runtime.execution_steps from public, anon, authenticated;
revoke all on table runtime.execution_step_dependencies from public, anon, authenticated;
revoke all on table runtime.connector_capabilities from public, anon, authenticated;
revoke all on function runtime.text_array_is_unique(text[]) from public, anon, authenticated;
revoke all on function runtime.touch_forge_updated_at() from public, anon, authenticated;
revoke all on function runtime.validate_forge_step() from public, anon, authenticated;
revoke all on function runtime.protect_forge_execution_identity() from public, anon, authenticated;

comment on table runtime.projects is
  'Closed Nemo Forge project metadata. Access is only through scoped public RPCs.';
comment on table runtime.project_executions is
  'Immutable-plan execution instances with tenant idempotency and fencing generation.';
comment on table runtime.execution_steps is
  'Fenced atomic DAG steps. Sensitive reasoning and plaintext provider secrets are prohibited.';
comment on table runtime.connector_capabilities is
  'Verified connector metadata only. Provider credentials must remain in the secret store.';

-- ─── 20260827100000_forge_event_bridge.sql ───────────────────────────────────────────────────
-- Nemo Forge Event Bridge: authenticated trigger registry and atomic handoff into
-- the existing Durable Runtime inbox + ADR 003 usage reservations.

create table runtime.event_triggers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  project_id uuid not null,
  provider text not null,
  event_type text not null,
  signature_mode text not null,
  secret_ref text not null,
  task_template text not null,
  estimated_units bigint not null,
  max_events_per_minute integer not null default 60,
  execution_mode text not null default 'shadow',
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint forge_event_triggers_account_id_id_key unique (account_id, id),
  constraint forge_event_triggers_project_fkey foreign key (account_id, project_id)
    references runtime.projects(account_id, id) on delete restrict,
  constraint forge_event_triggers_provider_check check (provider in ('amocrm', 'telegram', 'uzum')),
  constraint forge_event_triggers_type_check check (event_type in (
    'crm.lead.created', 'crm.lead.updated', 'telegram.command.received',
    'marketplace.order.status_changed', 'marketplace.stock.low'
  )),
  constraint forge_event_triggers_provider_type_check check (
    (provider = 'amocrm' and event_type in ('crm.lead.created', 'crm.lead.updated'))
    or (provider = 'telegram' and event_type = 'telegram.command.received')
    or (provider = 'uzum' and event_type in (
      'marketplace.order.status_changed', 'marketplace.stock.low'
    ))
  ),
  constraint forge_event_triggers_signature_check check (
    signature_mode in ('hmac_sha256', 'telegram_secret_token')
  ),
  constraint forge_event_triggers_secret_ref_check check (
    char_length(secret_ref) between 1 and 256
    and secret_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
  ),
  constraint forge_event_triggers_template_check check (
    char_length(task_template) between 3 and 4096 and octet_length(task_template) <= 16384
  ),
  constraint forge_event_triggers_units_check check (estimated_units between 1 and 1000000000),
  constraint forge_event_triggers_rate_check check (max_events_per_minute between 1 and 10000),
  constraint forge_event_triggers_mode_check check (execution_mode in ('shadow', 'live'))
);

-- This is a routing receipt, not a second payload inbox. The canonical immutable
-- payload remains in runtime.inbox_events and is referenced tenant-safely below.
create table runtime.inbound_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  trigger_id uuid not null,
  inbox_event_id uuid not null,
  workflow_id uuid not null,
  project_id uuid not null,
  execution_id uuid not null,
  reservation_id uuid not null,
  provider text not null,
  event_type text not null,
  external_event_id text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  payload_hash text not null,
  status text not null default 'routed',
  constraint forge_inbound_events_account_id_id_key unique (account_id, id),
  constraint forge_inbound_events_identity_key unique (account_id, provider, external_event_id),
  constraint forge_inbound_events_trigger_fkey foreign key (account_id, trigger_id)
    references runtime.event_triggers(account_id, id) on delete restrict,
  constraint forge_inbound_events_inbox_fkey foreign key (account_id, inbox_event_id)
    references runtime.inbox_events(account_id, id) on delete restrict,
  constraint forge_inbound_events_workflow_fkey foreign key (account_id, workflow_id)
    references runtime.workflow_runs(account_id, id) on delete restrict,
  constraint forge_inbound_events_project_fkey foreign key (account_id, project_id)
    references runtime.projects(account_id, id) on delete restrict,
  constraint forge_inbound_events_execution_fkey foreign key (account_id, execution_id)
    references runtime.project_executions(account_id, id) on delete restrict,
  constraint forge_inbound_events_reservation_fkey foreign key (account_id, reservation_id)
    references billing.usage_reservations(account_id, id) on delete restrict,
  constraint forge_inbound_events_external_id_check check (
    char_length(external_event_id) between 1 and 256
    and external_event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
  ),
  constraint forge_inbound_events_payload_hash_check check (payload_hash ~ '^[a-f0-9]{64}$'),
  constraint forge_inbound_events_status_check check (status in ('routed', 'completed', 'failed'))
);

create trigger forge_event_triggers_touch
before update on runtime.event_triggers
for each row execute function runtime.touch_forge_updated_at();

create trigger forge_inbound_events_immutable
before update or delete on runtime.inbound_events
for each row execute function runtime.prevent_mutation();

create index forge_event_triggers_lookup_idx
  on runtime.event_triggers (id, provider) where active;
create index forge_inbound_events_account_received_idx
  on runtime.inbound_events (account_id, received_at desc, id);

alter table runtime.event_triggers enable row level security;
alter table runtime.inbound_events enable row level security;

revoke all on table runtime.event_triggers from public, anon, authenticated;
revoke all on table runtime.inbound_events from public, anon, authenticated;

create function public.runtime_resolve_forge_event_trigger(
  p_trigger_id uuid,
  p_provider text
)
returns table (
  id uuid,
  account_id uuid,
  project_id uuid,
  provider text,
  event_type text,
  signature_mode text,
  secret_ref text,
  task_template text,
  estimated_units bigint,
  max_events_per_minute integer,
  execution_mode text,
  active boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select trigger.id, trigger.account_id, trigger.project_id, trigger.provider,
    trigger.event_type, trigger.signature_mode, trigger.secret_ref,
    trigger.task_template, trigger.estimated_units, trigger.max_events_per_minute,
    trigger.execution_mode, trigger.active
  from runtime.event_triggers as trigger
  where trigger.id = p_trigger_id and trigger.provider = p_provider and trigger.active
$$;

create function public.runtime_enqueue_forge_event(
  p_account_id uuid,
  p_trigger_id uuid,
  p_external_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_payload_hash text,
  p_plan jsonb,
  p_estimated_units bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trigger runtime.event_triggers%rowtype;
  v_existing runtime.inbound_events%rowtype;
  v_reservation jsonb;
  v_ingest jsonb;
  v_reservation_id uuid;
  v_inbox_id uuid;
  v_workflow_id uuid;
  v_execution_id uuid;
  v_receipt_id uuid;
  v_execution_created boolean := false;
  v_idempotency_key text;
begin
  if p_account_id is null or p_trigger_id is null then
    raise exception using errcode = '22023', message = 'invalid event identity';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 65536 then
    raise exception using errcode = '22023', message = 'invalid event payload';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'payload integrity mismatch';
  end if;
  if p_occurred_at is null
     or p_occurred_at < clock_timestamp() - interval '5 minutes'
     or p_occurred_at > clock_timestamp() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'event timestamp outside replay window';
  end if;

  select trigger.* into v_trigger
  from runtime.event_triggers as trigger
  where trigger.account_id = p_account_id and trigger.id = p_trigger_id
  for update;
  if not found or not v_trigger.active then
    raise exception using errcode = '28000', message = 'event rejected';
  end if;
  if p_event_type <> v_trigger.event_type or p_estimated_units <> v_trigger.estimated_units then
    raise exception using errcode = '22023', message = 'event trigger contract mismatch';
  end if;
  select inbound.* into v_existing
  from runtime.inbound_events as inbound
  where inbound.account_id = p_account_id
    and inbound.provider = v_trigger.provider
    and inbound.external_event_id = p_external_event_id;
  if found then
    if v_existing.event_type <> p_event_type or v_existing.payload_hash <> p_payload_hash then
      raise exception using errcode = '23000', message = 'event identity collision';
    end if;
    return jsonb_build_object(
      'status', 'duplicate',
      'inbound_event_id', v_existing.id,
      'workflow_id', v_existing.workflow_id,
      'execution_id', v_existing.execution_id,
      'reservation_id', v_existing.reservation_id
    );
  end if;
  if (
    select count(*)
    from runtime.inbound_events as inbound
    where inbound.account_id = p_account_id
      and inbound.trigger_id = p_trigger_id
      and inbound.received_at >= clock_timestamp() - interval '1 minute'
  ) >= v_trigger.max_events_per_minute then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object'
     or p_plan->>'schemaVersion' <> '1.0'
     or p_plan->>'projectId' <> v_trigger.project_id::text
     or jsonb_typeof(p_plan->'steps') <> 'array'
     or jsonb_array_length(p_plan->'steps') not between 1 and 32 then
    raise exception using errcode = '22023', message = 'invalid Forge plan';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_plan->'steps') with ordinality as step(value, position)
    where step.value->>'type' = 'publish'
      and not exists (
        select 1 from jsonb_array_elements(p_plan->'steps') with ordinality as approval(value, position)
        where approval.position < step.position
          and approval.value->>'type' = 'approval'
          and (step.value->'dependsOn') ? (approval.value->>'stepId')
      )
  ) then
    raise exception using errcode = '23514', message = 'publish requires a preceding approval dependency';
  end if;

  v_idempotency_key := 'forge-event:' || runtime.sha256_text(
    p_account_id::text || ':' || v_trigger.provider || ':' || p_external_event_id
  );
  v_reservation := billing.reserve_usage(
    p_account_id, v_idempotency_key, p_estimated_units, 'forge-event-bridge', 300
  );
  if coalesce(v_reservation->>'status', '') not in ('reserved', 'finalized')
     or v_reservation->>'reservation_id' is null then
    return jsonb_build_object('status', 'budget_denied');
  end if;
  v_reservation_id := (v_reservation->>'reservation_id')::uuid;

  v_ingest := public.runtime_ingest_event(
    p_account_id, v_trigger.provider, p_external_event_id, p_payload,
    v_trigger.execution_mode, gen_random_uuid(), p_event_type, p_occurred_at,
    'forge-event-bridge-v1', 'v1', 'forge_event_trigger', 'v1', 'forge-event-bridge'
  );
  v_inbox_id := (v_ingest->>'inbox_event_id')::uuid;
  v_workflow_id := (v_ingest->>'workflow_id')::uuid;

  insert into runtime.project_executions (
    account_id, project_id, workflow_id, idempotency_key, plan_snapshot, status
  ) values (
    p_account_id, v_trigger.project_id, v_workflow_id, v_idempotency_key, p_plan, 'queued'
  )
  on conflict (account_id, project_id, idempotency_key) do nothing
  returning id into v_execution_id;

  if v_execution_id is null then
    select execution.id into strict v_execution_id
    from runtime.project_executions as execution
    where execution.account_id = p_account_id
      and execution.project_id = v_trigger.project_id
      and execution.idempotency_key = v_idempotency_key;
  else
    v_execution_created := true;
  end if;

  if v_execution_created then
    insert into runtime.execution_steps (
      account_id, execution_id, step_index, title, step_type, status,
      assigned_skill_id, compute_profile, evidence_refs, artifact_refs,
      cost_tokens, estimated_cost_usd, requires_approval
    )
    select
      p_account_id, v_execution_id, step.position - 1,
      step.value->>'title', step.value->>'type', step.value->>'status',
      step.value->>'assignedSkillId', step.value->>'computeProfile',
      coalesce(step.value->'evidenceRefs', '[]'::jsonb),
      coalesce(step.value->'artifactRefs', '[]'::jsonb),
      coalesce((step.value->>'costTokens')::bigint, 0),
      coalesce((step.value->>'estimatedCostUsd')::numeric, 0),
      coalesce((step.value->>'requiresApproval')::boolean, false)
    from jsonb_array_elements(p_plan->'steps') with ordinality as step(value, position);

    insert into runtime.execution_step_dependencies (
      account_id, execution_id, step_id, depends_on_step_id
    )
    select p_account_id, v_execution_id, target.id, dependency.id
    from jsonb_array_elements(p_plan->'steps') with ordinality as plan_step(value, position)
    join runtime.execution_steps as target
      on target.account_id = p_account_id and target.execution_id = v_execution_id
      and target.step_index = plan_step.position - 1
    cross join lateral jsonb_array_elements_text(plan_step.value->'dependsOn') as dependency_ref(step_id)
    join jsonb_array_elements(p_plan->'steps') with ordinality as dependency_plan(value, position)
      on dependency_plan.value->>'stepId' = dependency_ref.step_id
    join runtime.execution_steps as dependency
      on dependency.account_id = p_account_id and dependency.execution_id = v_execution_id
      and dependency.step_index = dependency_plan.position - 1;
  end if;

  insert into runtime.inbound_events (
    account_id, trigger_id, inbox_event_id, workflow_id, project_id,
    execution_id, reservation_id, provider, event_type, external_event_id,
    occurred_at, payload_hash
  ) values (
    p_account_id, p_trigger_id, v_inbox_id, v_workflow_id, v_trigger.project_id,
    v_execution_id, v_reservation_id, v_trigger.provider, p_event_type,
    p_external_event_id, p_occurred_at, p_payload_hash
  )
  on conflict (account_id, provider, external_event_id) do nothing
  returning id into v_receipt_id;

  if v_receipt_id is null then
    select inbound.id into strict v_receipt_id
    from runtime.inbound_events as inbound
    where inbound.account_id = p_account_id
      and inbound.provider = v_trigger.provider
      and inbound.external_event_id = p_external_event_id;
  end if;

  return jsonb_build_object(
    'status', case when v_execution_created then 'created' else 'duplicate' end,
    'inbound_event_id', v_receipt_id,
    'workflow_id', v_workflow_id,
    'execution_id', v_execution_id,
    'reservation_id', v_reservation_id
  );
end
$$;

revoke all on function public.runtime_enqueue_forge_event(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, bigint
) from public, anon, authenticated;
revoke all on function public.runtime_resolve_forge_event_trigger(uuid, text)
  from public, anon, authenticated;
grant execute on function public.runtime_resolve_forge_event_trigger(uuid, text)
  to service_role;
grant execute on function public.runtime_enqueue_forge_event(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, bigint
) to service_role;

comment on table runtime.event_triggers is
  'Tenant-scoped Forge trigger metadata. secret_ref points to an external secret manager; plaintext secrets are forbidden.';
comment on table runtime.inbound_events is
  'Immutable Event Bridge routing receipts referencing the canonical runtime.inbox_events payload.';
comment on function public.runtime_resolve_forge_event_trigger(uuid, text) is
  'Service-only trigger resolution. secret_ref is an opaque secret-manager locator, never plaintext secret material.';
comment on function public.runtime_enqueue_forge_event(
  uuid, uuid, text, text, timestamptz, jsonb, text, jsonb, bigint
) is 'Service-only atomic ADR 003 reservation, Durable Inbox ingestion, and Forge DAG creation.';

commit;
