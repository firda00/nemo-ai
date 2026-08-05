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
