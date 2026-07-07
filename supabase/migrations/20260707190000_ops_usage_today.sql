-- Lightweight aggregate for the ops watchdog's cost guard: today's total tokens plus the
-- single top-spending account. Done in the DB (no row fetch) so it scales at 40k users.
create or replace function public.ops_usage_today()
returns table (total bigint, top_account uuid, top_tokens bigint)
language sql
security definer
set search_path = public
as $$
  with day as (
    select account_id, tokens from usage where created_at >= date_trunc('day', now())
  ), tops as (
    select account_id, sum(tokens) as t from day group by account_id order by t desc limit 1
  )
  select coalesce((select sum(tokens) from day), 0)::bigint,
         (select account_id from tops),
         coalesce((select t from tops), 0)::bigint;
$$;

revoke all on function public.ops_usage_today() from public;
