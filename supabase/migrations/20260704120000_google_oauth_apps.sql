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
