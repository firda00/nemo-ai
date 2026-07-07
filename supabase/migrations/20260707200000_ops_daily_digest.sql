-- Per-account daily digest aggregate for the founder pulse agent. For every account that set
-- an operator/owner Telegram (business_profiles.notify_chat_id), returns yesterday's dialogues,
-- new leads and tokens burned — all computed in the DB (no row fetch) so it scales.
create or replace function public.ops_daily_digest()
returns table (account_id uuid, notify_chat_id text, dialogues bigint, leads bigint, tokens bigint)
language sql
security definer
set search_path = public
as $$
  with y as (
    select (date_trunc('day', now()) - interval '1 day') as lo, date_trunc('day', now()) as hi
  ),
  d as (
    select ag.account_id, count(*)::bigint as c
    from dialogues dl join agents ag on ag.id = dl.agent_id, y
    where dl.created_at >= y.lo and dl.created_at < y.hi
    group by ag.account_id
  ),
  l as (
    select ag.account_id, count(*)::bigint as c
    from leads le
      join dialogues dl on dl.id = le.dialogue_id
      join agents ag on ag.id = dl.agent_id, y
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

revoke all on function public.ops_daily_digest() from anon, authenticated;
