-- Team-quality escalation is owner work, not an external action, but it still
-- needs a durable inbox and an auditable decision. Keep the generated peer
-- review intact; store the owner's decision separately.
alter table public.research_runs
  add column if not exists human_review_status text,
  add column if not exists human_reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists human_reviewed_at timestamptz;

alter table public.research_runs
  drop constraint if exists research_runs_human_review_status_check;
alter table public.research_runs
  add constraint research_runs_human_review_status_check
  check (human_review_status is null or human_review_status in ('pending', 'approved', 'rejected')) not valid;
alter table public.research_runs validate constraint research_runs_human_review_status_check;

alter table public.approval_requests
  add column if not exists related_research_run_id uuid references public.research_runs(id) on delete cascade;

alter table public.approval_requests
  drop constraint if exists approval_requests_related_research_run_id_fkey;
alter table public.approval_requests
  add constraint approval_requests_related_research_run_id_fkey
  foreign key (related_research_run_id) references public.research_runs(id) on delete set null;

-- Report creation remains available through existing RLS, but browser roles
-- cannot forge owner decisions or erase their audit trail.
revoke update, delete on public.research_runs from anon, authenticated;

create unique index if not exists approval_requests_research_review_uidx
  on public.approval_requests (account_id, related_research_run_id)
  where source = 'workflow' and action_type = 'research_quality_review';

create or replace function public.prepare_research_quality_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'needs_review' and new.human_review_status is null then
    new.human_review_status := 'pending';
  end if;
  return new;
end
$$;

create or replace function public.queue_research_quality_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  section_count integer;
begin
  if new.status <> 'needs_review' or new.human_review_status <> 'pending' then return new; end if;

  select count(*)::integer into section_count
  from jsonb_array_elements(case when jsonb_typeof(new.steps) = 'array' then new.steps else '[]'::jsonb end) step
  where coalesce((step->'review'->>'needs_human_review')::boolean, false);

  insert into public.approval_requests (
    account_id, source, action_type, summary, evidence, related_research_run_id, expires_at
  ) values (
    new.account_id,
    'workflow',
    'research_quality_review',
    left(new.task, 240),
    jsonb_build_object('research_run_id', new.id, 'run_ref', new.run_ref, 'sections', section_count),
    new.id,
    now() + interval '10 years'
  )
  on conflict (account_id, related_research_run_id)
    where source = 'workflow' and action_type = 'research_quality_review'
    do nothing;
  return new;
end
$$;

drop trigger if exists research_quality_review_prepare on public.research_runs;
create trigger research_quality_review_prepare
before insert or update of status on public.research_runs
for each row execute function public.prepare_research_quality_review();

drop trigger if exists research_quality_review_queue on public.research_runs;
create trigger research_quality_review_queue
after insert or update of status on public.research_runs
for each row execute function public.queue_research_quality_review();

create or replace function public.decide_approval_request(
  p_account_id uuid,
  p_user_id uuid,
  p_request_id uuid,
  p_decision text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.approval_requests;
begin
  if p_decision not in ('approved', 'rejected') then raise exception 'invalid decision'; end if;
  if not exists (
    select 1 from public.users where id = p_user_id and account_id = p_account_id
  ) then raise exception 'invalid owner context'; end if;

  select * into request_row
  from public.approval_requests
  where id = p_request_id and account_id = p_account_id and status = 'pending' and expires_at > now()
  for update;
  if not found then return false; end if;

  update public.approval_requests
  set status = p_decision, decided_by = p_user_id, decided_at = now()
  where id = request_row.id;

  if request_row.source = 'workflow'
    and request_row.action_type = 'research_quality_review'
    and request_row.related_research_run_id is not null then
    update public.research_runs
    set human_review_status = p_decision,
        human_reviewed_by = p_user_id,
        human_reviewed_at = now(),
        status = case when p_decision = 'approved' then 'done' else 'review_rejected' end
    where id = request_row.related_research_run_id
      and account_id = p_account_id
      and human_review_status = 'pending';
    if not found then raise exception 'research review is no longer pending'; end if;
  end if;

  return true;
end
$$;

revoke all on function public.decide_approval_request(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.decide_approval_request(uuid,uuid,uuid,text) to service_role;

-- Existing escalated reports must appear immediately after deployment.
update public.research_runs
set human_review_status = 'pending'
where status = 'needs_review' and human_review_status is null;

insert into public.approval_requests (
  account_id, source, action_type, summary, evidence, related_research_run_id, expires_at
)
select
  run.account_id,
  'workflow',
  'research_quality_review',
  left(run.task, 240),
  jsonb_build_object(
    'research_run_id', run.id,
    'run_ref', run.run_ref,
    'sections', (
      select count(*) from jsonb_array_elements(case when jsonb_typeof(run.steps) = 'array' then run.steps else '[]'::jsonb end) step
      where coalesce((step->'review'->>'needs_human_review')::boolean, false)
    )
  ),
  run.id,
  now() + interval '10 years'
from public.research_runs run
where run.status = 'needs_review' and run.human_review_status = 'pending'
on conflict (account_id, related_research_run_id)
  where source = 'workflow' and action_type = 'research_quality_review'
  do nothing;
