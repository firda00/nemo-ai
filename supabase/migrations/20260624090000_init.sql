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
