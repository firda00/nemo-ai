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
