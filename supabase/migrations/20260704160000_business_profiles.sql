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
