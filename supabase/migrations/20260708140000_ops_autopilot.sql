-- Autonomous "AI COO" (autopilot): each day an agent reads the account's real state and
-- produces a short assessment + top actions, delivered to the owner and logged. This is the
-- "the platform runs itself" layer — no human needed to watch the numbers.

-- decisions log (per account), visible in the panel
create table if not exists public.ops_reports (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  kind       text not null default 'autopilot',
  summary    text,
  actions    jsonb,
  created_at timestamptz not null default now()
);
alter table public.ops_reports enable row level security;
drop policy if exists ops_reports_acc on public.ops_reports;
create policy ops_reports_acc on public.ops_reports for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());
create index if not exists ops_reports_acc_idx on public.ops_reports (account_id, created_at desc);

-- per-account daily signals for the autopilot (Asia/Tashkent day). SECURITY DEFINER, service role only.
create or replace function public.ops_autopilot_signals()
returns table (
  account_id     uuid,
  notify_chat_id text,
  dialogues      bigint,
  leads          bigint,
  open_tasks     bigint,
  overdue_tasks  bigint,
  needs_operator bigint
)
language sql
security definer
set search_path = public
as $$
  with d as (
    select (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent' as lo
  ),
  dia as (
    select ag.account_id, count(*)::bigint c
    from dialogues dl join agents ag on ag.id = dl.agent_id, d
    where dl.created_at >= d.lo group by ag.account_id
  ),
  nop as (
    select ag.account_id, count(*)::bigint c
    from dialogues dl join agents ag on ag.id = dl.agent_id
    where dl.status = 'needs_operator' group by ag.account_id
  ),
  led as (
    select ag.account_id, count(*)::bigint c
    from leads le join dialogues dl on dl.id = le.dialogue_id join agents ag on ag.id = dl.agent_id, d
    where le.created_at >= d.lo group by ag.account_id
  ),
  tsk as (
    select t.account_id,
      count(*) filter (where coalesce(t.status,'todo') <> 'done')::bigint as open_cnt,
      count(*) filter (where coalesce(t.status,'todo') <> 'done' and t.due_at is not null and t.due_at < now())::bigint as overdue_cnt
    from tasks t group by t.account_id
  )
  select bp.account_id, bp.notify_chat_id,
         coalesce(dia.c,0), coalesce(led.c,0), coalesce(tsk.open_cnt,0), coalesce(tsk.overdue_cnt,0), coalesce(nop.c,0)
  from business_profiles bp
  left join dia on dia.account_id = bp.account_id
  left join nop on nop.account_id = bp.account_id
  left join led on led.account_id = bp.account_id
  left join tsk on tsk.account_id = bp.account_id
  where bp.notify_chat_id is not null and bp.notify_chat_id <> '';
$$;

revoke all on function public.ops_autopilot_signals() from public, anon, authenticated;
grant execute on function public.ops_autopilot_signals() to service_role;
