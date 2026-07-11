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
