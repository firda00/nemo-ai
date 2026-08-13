create table if not exists public.google_oauth_transactions (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  account_id uuid not null references public.accounts(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.google_oauth_transactions enable row level security;
revoke all on public.google_oauth_transactions from anon, authenticated;

create or replace function public.consume_google_oauth_transaction(p_state_hash text)
returns table(account_id uuid)
language sql
security definer
set search_path = ''
as $$
  update public.google_oauth_transactions
  set used_at = now()
  where state_hash = p_state_hash
    and used_at is null
    and expires_at > now()
  returning google_oauth_transactions.account_id;
$$;

revoke all on function public.consume_google_oauth_transaction(text) from public, anon, authenticated;
grant execute on function public.consume_google_oauth_transaction(text) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'private-audio',
  'private-audio',
  false,
  188743680,
  array['audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/ogg','audio/webm','video/mp4','application/octet-stream']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload own private audio" on storage.objects;
create policy "Users upload own private audio"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'private-audio'
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] = 'audio'
  );

alter table public.browser_observations
  add column if not exists expires_at timestamptz;

update public.browser_observations
set expires_at = least(coalesce(expires_at, created_at + interval '24 hours'), created_at + interval '24 hours')
where expires_at is null or expires_at > created_at + interval '24 hours';

alter table public.browser_observations
  alter column expires_at set default (now() + interval '24 hours'),
  alter column expires_at set not null;

create index if not exists browser_observations_expiry_idx on public.browser_observations(expires_at);

create or replace function public.purge_expired_browser_observations()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.browser_observations where expires_at <= now();
  delete from public.google_oauth_transactions where expires_at <= now() - interval '24 hours';
$$;

revoke all on function public.purge_expired_browser_observations() from public, anon, authenticated;
grant execute on function public.purge_expired_browser_observations() to service_role;

do $$
begin
  if exists(select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'nemo-private-data-retention';
    perform cron.schedule('nemo-private-data-retention', '17 * * * *', 'select public.purge_expired_browser_observations();');
  end if;
end;
$$;
