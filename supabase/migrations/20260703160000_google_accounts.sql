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
