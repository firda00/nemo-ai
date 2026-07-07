-- Review fixes for the ops agents:
--  1) make the migration set reproducible — ensure business_profiles has the columns the
--     app/functions already rely on (present on prod, but never added by a committed migration);
--  2) close the SECURITY DEFINER leak properly — revoke EXECUTE from PUBLIC (the earlier
--     `revoke from anon, authenticated` left the default PUBLIC grant intact);
--  3) compute the day boundary in Asia/Tashkent (was UTC, shifting "today"/"yesterday" ~5h).

alter table public.business_profiles add column if not exists notify_chat_id text;
alter table public.business_profiles add column if not exists phone text;
alter table public.business_profiles add column if not exists tasks_sheet_id text;

-- today's total tokens + the single top-spending account (Tashkent day)
create or replace function public.ops_usage_today()
returns table (total bigint, top_account uuid, top_tokens bigint)
language sql
security definer
set search_path = public
as $$
  with b as (
    select (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent' as lo
  ), day as (
    select account_id, tokens from usage, b where created_at >= b.lo
  ), tops as (
    select account_id, sum(tokens) as t from day group by account_id order by t desc limit 1
  )
  select coalesce((select sum(tokens) from day), 0)::bigint,
         (select account_id from tops),
         coalesce((select t from tops), 0)::bigint;
$$;

-- per-account yesterday digest (Tashkent day) for accounts with an owner Telegram
create or replace function public.ops_daily_digest()
returns table (account_id uuid, notify_chat_id text, dialogues bigint, leads bigint, tokens bigint)
language sql
security definer
set search_path = public
as $$
  with y as (
    select (date_trunc('day', now() at time zone 'Asia/Tashkent') - interval '1 day') at time zone 'Asia/Tashkent' as lo,
           (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent' as hi
  ),
  d as (
    select ag.account_id, count(*)::bigint as c
    from dialogues dl join agents ag on ag.id = dl.agent_id, y
    where dl.created_at >= y.lo and dl.created_at < y.hi
    group by ag.account_id
  ),
  l as (
    select ag.account_id, count(*)::bigint as c
    from leads le join dialogues dl on dl.id = le.dialogue_id join agents ag on ag.id = dl.agent_id, y
    where le.created_at >= y.lo and le.created_at < y.hi
    group by ag.account_id
  ),
  t as (
    select u.account_id, sum(u.tokens)::bigint as s
    from usage u, y
    where u.created_at >= y.lo and u.created_at < y.hi
    group by u.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(d.c, 0)::bigint, coalesce(l.c, 0)::bigint, coalesce(t.s, 0)::bigint
  from business_profiles bp
  left join d on d.account_id = bp.account_id
  left join l on l.account_id = bp.account_id
  left join t on t.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_usage_today() from public;
revoke all on function public.ops_daily_digest() from public;
grant execute on function public.ops_usage_today() to service_role;
grant execute on function public.ops_daily_digest() to service_role;
