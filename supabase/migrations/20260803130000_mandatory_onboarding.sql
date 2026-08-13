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
