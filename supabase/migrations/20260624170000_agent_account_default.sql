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
