-- Visual RAG (PixelRAG/OCR) pilot — additive, feature-flagged OFF by default.
-- Clients can only SUBMIT (rate/size/concurrency-limited RPC) and READ their own
-- account's rows. All processing writes belong to the service-role worker. The
-- Qdrant contract is defense-in-depth: every point carries account_id in its
-- payload AND every query must filter by account_id.
create table if not exists public.visual_rag_jobs (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references public.accounts(id) on delete cascade,
  created_by   uuid not null references auth.users(id) on delete cascade,
  source_path  text not null,
  source_bytes bigint not null check (source_bytes >= 1 and source_bytes <= 20971520),
  page_count   int not null check (page_count >= 1 and page_count <= 200),
  status       text not null default 'queued'
               check (status in ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  result_path  text,
  error_code   text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz
);

-- Composite uniqueness lets page rows prove that their account_id belongs to
-- the same tenant as the parent job, even for service-role worker writes.
alter table public.visual_rag_jobs
  add constraint visual_rag_jobs_id_account_key unique (id, account_id);

create index if not exists visual_rag_jobs_account_idx
  on public.visual_rag_jobs (account_id, created_at desc);
-- fast "active jobs" count for the per-account concurrency gate
create index if not exists visual_rag_jobs_active_idx
  on public.visual_rag_jobs (account_id)
  where status in ('queued', 'processing');
-- fast oldest-queued claim
create index if not exists visual_rag_jobs_queued_idx
  on public.visual_rag_jobs (created_at)
  where status = 'queued';

create table if not exists public.visual_rag_pages (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null,
  account_id      uuid not null references public.accounts(id) on delete cascade,
  page_number     int not null check (page_number >= 1 and page_number <= 200),
  text_content    text,
  qdrant_point_id uuid,
  created_at      timestamptz not null default now(),
  unique (job_id, page_number),
  constraint visual_rag_pages_job_account_fk
    foreign key (job_id, account_id)
    references public.visual_rag_jobs(id, account_id) on delete cascade
);

create index if not exists visual_rag_pages_account_idx
  on public.visual_rag_pages (account_id, created_at desc);

-- RLS: members of the account may SELECT; there are NO client write policies.
-- The service-role worker bypasses RLS for processing writes.
alter table public.visual_rag_jobs enable row level security;
alter table public.visual_rag_pages enable row level security;

drop policy if exists visual_rag_jobs_select_acc on public.visual_rag_jobs;
create policy visual_rag_jobs_select_acc on public.visual_rag_jobs
  for select to authenticated
  using (account_id = public.current_account_id());

drop policy if exists visual_rag_pages_select_acc on public.visual_rag_pages;
create policy visual_rag_pages_select_acc on public.visual_rag_pages
  for select to authenticated
  using (account_id = public.current_account_id());

revoke all on public.visual_rag_jobs from public, anon, authenticated;
revoke all on public.visual_rag_pages from public, anon, authenticated;
grant select on public.visual_rag_jobs to authenticated;
grant select on public.visual_rag_pages to authenticated;

-- Submission gate. Derives the account from the caller (never accepts an
-- account_id argument), checks the feature flag, validates the storage path,
-- then serializes per-account limit checks with an advisory xact lock so
-- concurrent submissions cannot both pass the same limit window.
create or replace function public.submit_visual_rag_job(
  p_source_path text,
  p_source_bytes bigint,
  p_page_count int
)
returns setof public.visual_rag_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid       uuid;
  v_account   uuid;
  v_prefix    text;
  v_active    int;
  v_pages_24h bigint;
  v_subs_1m   int;
  v_job       public.visual_rag_jobs;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  select u.account_id into v_account from public.users u where u.id = v_uid;
  if v_account is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;

  if coalesce(current_setting('app.visual_rag_enabled', true), '') <> 'on' then
    raise exception 'feature_disabled';
  end if;

  -- normalized storage path: must live under <account>/visual-rag/ and cannot
  -- traverse ('..'), use backslashes, start with '/', or have an empty remainder
  if p_source_path is null
     or position('..' in p_source_path) > 0
     or position('\' in p_source_path) > 0
     or left(p_source_path, 1) = '/' then
    raise exception 'invalid_path';
  end if;
  v_prefix := v_account::text || '/visual-rag/';
  if left(p_source_path, length(v_prefix)) <> v_prefix
     or length(p_source_path) <= length(v_prefix) then
    raise exception 'invalid_path';
  end if;

  if p_source_bytes is null or p_source_bytes < 1 or p_source_bytes > 20971520 then
    raise exception 'invalid_size';
  end if;
  if p_page_count is null or p_page_count < 1 or p_page_count > 200 then
    raise exception 'invalid_pages';
  end if;

  -- serialize all limit checks per account
  perform pg_advisory_xact_lock(hashtextextended(v_account::text, 0));

  select count(*) into v_active
    from public.visual_rag_jobs
   where account_id = v_account and status in ('queued', 'processing');
  if v_active >= 2 then
    raise exception 'active_job_limit';
  end if;

  select coalesce(sum(page_count), 0) into v_pages_24h
    from public.visual_rag_jobs
   where account_id = v_account and created_at > now() - interval '24 hours';
  if v_pages_24h + p_page_count > 1000 then
    raise exception 'daily_page_limit';
  end if;

  select count(*) into v_subs_1m
    from public.visual_rag_jobs
   where account_id = v_account and created_at > now() - interval '1 minute';
  if v_subs_1m >= 30 then
    raise exception 'rate_limited';
  end if;

  insert into public.visual_rag_jobs (account_id, created_by, source_path, source_bytes, page_count)
  values (v_account, v_uid, p_source_path, p_source_bytes, p_page_count)
  returning * into v_job;
  return next v_job;
end;
$$;

revoke all on function public.submit_visual_rag_job(text, bigint, int) from public, anon;
grant execute on function public.submit_visual_rag_job(text, bigint, int) to authenticated;

-- Status read scoped to the caller's account (empty set on cross-tenant ids).
create or replace function public.get_visual_rag_job(p_job_id uuid)
returns setof public.visual_rag_jobs
language sql
security definer
set search_path = public
stable
as $$
  select j.*
    from public.visual_rag_jobs j
   where j.id = p_job_id
     and j.account_id = (select u.account_id from public.users u where u.id = auth.uid());
$$;

revoke all on function public.get_visual_rag_job(uuid) from public, anon;
grant execute on function public.get_visual_rag_job(uuid) to authenticated;

-- Worker claim: oldest queued job, SKIP LOCKED so parallel workers never
-- double-claim. The returned row carries id/account_id/source_path — the worker
-- payload contract (account_id must reach the Qdrant point payload).
create or replace function public.claim_visual_rag_job()
returns setof public.visual_rag_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.visual_rag_jobs j
     set status = 'processing', started_at = now()
   where j.id = (
     select q.id from public.visual_rag_jobs q
      where q.status = 'queued'
      order by q.created_at
      for update skip locked
      limit 1
   )
   returning j.*;
end;
$$;

revoke all on function public.claim_visual_rag_job() from public, anon, authenticated;
grant execute on function public.claim_visual_rag_job() to service_role;

-- Worker finalize: only a queued/processing job can finish, exactly once.
create or replace function public.finalize_visual_rag_job(
  p_job_id uuid,
  p_status text,
  p_result_path text default null,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid_status';
  end if;
  update public.visual_rag_jobs
     set status = p_status,
         result_path = p_result_path,
         error_code = p_error_code,
         completed_at = now()
   where id = p_job_id
     and status in ('queued', 'processing');
  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.finalize_visual_rag_job(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.finalize_visual_rag_job(uuid, text, text, text) to service_role;
