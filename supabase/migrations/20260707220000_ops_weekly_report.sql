-- Weekly team report aggregate: for every account with an owner Telegram, this week's task
-- stats (created / still open / overdue). Computed in the DB (Asia/Tashkent week). SECURITY
-- DEFINER, but EXECUTE revoked from PUBLIC (only the service role calls it from the cron fn).
create or replace function public.ops_weekly_report()
returns table (account_id uuid, notify_chat_id text, created bigint, open_cnt bigint, overdue bigint)
language sql
security definer
set search_path = public
as $$
  with w as (
    select (date_trunc('week', now() at time zone 'Asia/Tashkent') - interval '7 days') at time zone 'Asia/Tashkent' as lo
  ),
  agg as (
    select t.account_id,
      count(*) filter (where t.created_at >= w.lo)::bigint as created,
      count(*) filter (where coalesce(t.status,'open') <> 'done')::bigint as open_cnt,
      count(*) filter (where coalesce(t.status,'open') <> 'done' and t.due_at is not null and t.due_at < now())::bigint as overdue
    from tasks t, w
    group by t.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(a.created, 0)::bigint, coalesce(a.open_cnt, 0)::bigint, coalesce(a.overdue, 0)::bigint
  from business_profiles bp
  left join agg a on a.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_weekly_report() from public;
grant execute on function public.ops_weekly_report() to service_role;
