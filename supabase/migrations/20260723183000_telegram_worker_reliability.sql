-- Make Telegram queueing atomic and make the worker lease self-healing.
-- A missing lease row previously made every worker invocation report that
-- another worker was draining, leaving voice messages unread forever.

create or replace function public.acquire_worker_lease(secs int default 60)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired boolean := false;
begin
  insert into public.worker_lease(id, locked_until)
  values (1, pg_catalog.now())
  on conflict (id) do nothing;

  update public.worker_lease
     set locked_until = pg_catalog.now() + pg_catalog.make_interval(secs => greatest(1, least(secs, 300)))
   where id = 1
     and locked_until <= pg_catalog.now()
  returning true into acquired;

  return coalesce(acquired, false);
end
$$;

create or replace function public.release_worker_lease()
returns boolean
language sql
security definer
set search_path = ''
as $$
  update public.worker_lease
     set locked_until = pg_catalog.now()
   where id = 1
  returning true
$$;

create or replace function public.enqueue_telegram_job(
  p_channel_id uuid,
  p_update_id bigint,
  p_payload jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_rows integer := 0;
begin
  if p_channel_id is null or p_payload is null then
    raise exception 'invalid telegram queue payload';
  end if;

  if p_update_id is not null then
    insert into public.tg_updates(channel_id, update_id, created_at)
    values (p_channel_id, p_update_id, pg_catalog.now())
    on conflict (channel_id, update_id) do nothing;
    get diagnostics inserted_rows = row_count;
    if inserted_rows = 0 then
      return false;
    end if;
  end if;

  perform pgmq.send('tg_jobs', p_payload);
  return true;
end
$$;

revoke all on function public.acquire_worker_lease(int) from public, anon, authenticated;
revoke all on function public.release_worker_lease() from public, anon, authenticated;
revoke all on function public.enqueue_telegram_job(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.acquire_worker_lease(int) to service_role;
grant execute on function public.release_worker_lease() to service_role;
grant execute on function public.enqueue_telegram_job(uuid, bigint, jsonb) to service_role;

