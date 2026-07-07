-- Ustudy Operations Team — real workflow persistence (Payment Control, Meeting to Tasks).
-- Reuses research_runs for the per-step agent trace + manager summary; adds tasks +
-- notifications so the two workflows produce durable, viewable business output.
-- Account-scoped via RLS like the rest of the schema.

-- tag each run by workflow kind + link it to the team department
alter table public.research_runs add column if not exists kind text not null default 'research';
  -- research | team_run | payment_control | meeting_to_tasks
alter table public.research_runs add column if not exists department_id uuid
  references public.departments(id) on delete set null;

-- tasks — Meeting-to-Tasks output (also usable for manual tasks)
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  run_id        uuid references public.research_runs(id) on delete set null,
  title         text not null,
  owner         text,
  deadline      date,
  priority      text not null default 'medium',    -- low | medium | high
  status        text not null default 'todo',       -- todo | in_progress | done | overdue
  source        text not null default 'meeting',    -- meeting | payment | manual
  details       text,
  created_at    timestamptz not null default now()
);

-- notifications — Payment-Control admin escalations (the "admin sees a task/notification")
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null default public.current_account_id() references public.accounts(id) on delete cascade,
  department_id uuid references public.departments(id) on delete set null,
  run_id        uuid references public.research_runs(id) on delete set null,
  kind          text not null default 'admin_escalation', -- admin_escalation | payment_risk | task_assigned
  title         text not null,
  body          text,
  risk          text,                               -- low | medium | high
  target        text,                               -- admin this escalation is for
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);

alter table public.tasks         enable row level security;
alter table public.notifications enable row level security;

drop policy if exists tasks_acc on public.tasks;
create policy tasks_acc on public.tasks for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

drop policy if exists notifications_acc on public.notifications;
create policy notifications_acc on public.notifications for all
  using (account_id = public.current_account_id())
  with check (account_id = public.current_account_id());

create index if not exists tasks_acc_idx on public.tasks (account_id, created_at desc);
create index if not exists notif_acc_idx on public.notifications (account_id, created_at desc);
create index if not exists research_runs_dept_idx on public.research_runs (department_id, created_at desc);
