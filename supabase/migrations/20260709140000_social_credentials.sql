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
