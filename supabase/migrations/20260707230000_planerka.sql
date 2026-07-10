-- Planerka (team stand-up) upgrade:
--  1) tasks carry PROOF of completion + partial PROGRESS + who/when closed it, so a person
--     can report "done" (with evidence) either in the group OR privately to the bot;
--  2) business_profiles gets a report language so the morning brief / weekly scorecard are
--     delivered in the language the owner picked (uz | ru | en);
--  3) ops_weekly_report keeps working; a new per-person scorecard RPC powers the weekly report
--     (promised / done / % / overdue-days), computed in the DB so it scales.
-- Account-scoped via RLS like the rest of the schema.

-- ---------- tasks: proof + progress + completion audit ----------
alter table public.tasks add column if not exists progress     int  not null default 0;   -- 0..100
alter table public.tasks add column if not exists proof_url    text;      -- telegram file_id or a link
alter table public.tasks add column if not exists proof_type   text;      -- photo | document | link | note
alter table public.tasks add column if not exists completed_at  timestamptz;
alter table public.tasks add column if not exists completed_by  text;     -- tg display name of who reported done

-- ---------- business_profiles: report language for briefs/reports ----------
alter table public.business_profiles add column if not exists report_lang text not null default 'ru';  -- uz | ru | en

-- ---------- per-person weekly scorecard (Asia/Tashkent week) ----------
-- One row per (chat, assignee): assigned this week, done this week, still open, overdue,
-- and the worst overdue-day count on their open tasks. SECURITY DEFINER; EXECUTE only for
-- the service role (the weekly-report cron function). Grouped in the DB so it scales at 40k.
create or replace function public.planerka_weekly_scorecard()
returns table (
  account_id       uuid,
  telegram_chat_id text,
  assignee         text,
  assigned         bigint,
  done             bigint,
  open_cnt         bigint,
  overdue          bigint,
  max_overdue_days int
)
language sql
security definer
set search_path = public
as $$
  with w as (
    select (date_trunc('week', now() at time zone 'Asia/Tashkent') - interval '7 days') at time zone 'Asia/Tashkent' as lo
  )
  select
    t.account_id,
    t.telegram_chat_id,
    coalesce(nullif(t.assignee_tg, ''), t.assignee_name, '—') as assignee,
    count(*) filter (where t.created_at >= w.lo)::bigint                                         as assigned,
    count(*) filter (where t.status = 'done' and coalesce(t.completed_at, t.created_at) >= w.lo)::bigint as done,
    count(*) filter (where coalesce(t.status,'todo') <> 'done')::bigint                          as open_cnt,
    count(*) filter (where coalesce(t.status,'todo') <> 'done' and t.due_at is not null and t.due_at < now())::bigint as overdue,
    coalesce(max(
      case when coalesce(t.status,'todo') <> 'done' and t.due_at is not null and t.due_at < now()
           then floor(extract(epoch from (now() - t.due_at)) / 86400)::int
           else 0 end
    ), 0) as max_overdue_days
  from tasks t, w
  where t.telegram_chat_id is not null
  group by t.account_id, t.telegram_chat_id, assignee;
$$;

-- lock it down: Supabase grants anon/authenticated EXECUTE directly, so revoking only from
-- PUBLIC leaves them able to call this SECURITY DEFINER function (which bypasses RLS and would
-- expose every account's chat ids + task counts). Revoke from all three, grant only the cron role.
revoke all on function public.planerka_weekly_scorecard() from public, anon, authenticated;
grant execute on function public.planerka_weekly_scorecard() to service_role;

-- Same hardening for the earlier ops DEFINER functions: `revoke ... from public` alone left
-- anon/authenticated able to EXECUTE them (Supabase grants those roles execute directly), which
-- exposed every account's notify chat + token totals. Revoke from all three; cron role only.
do $$
begin
  if to_regprocedure('public.ops_weekly_report()') is not null then
    revoke all on function public.ops_weekly_report() from public, anon, authenticated;
    grant execute on function public.ops_weekly_report() to service_role;
  end if;
  if to_regprocedure('public.ops_daily_digest()') is not null then
    revoke all on function public.ops_daily_digest() from public, anon, authenticated;
    grant execute on function public.ops_daily_digest() to service_role;
  end if;
  if to_regprocedure('public.ops_usage_today()') is not null then
    revoke all on function public.ops_usage_today() from public, anon, authenticated;
    grant execute on function public.ops_usage_today() to service_role;
  end if;
end $$;
