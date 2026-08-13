-- Claim-fenced durable execution for autonomous team runs. Browser roles never
-- receive direct table/RPC access; authenticated reads are mediated by orchestrate.
alter table public.autonomous_run_checkpoints
  add column if not exists transition text not null default 'staff',
  add column if not exists specialist_cursor integer not null default 0,
  add column if not exists review_cursor integer not null default 0,
  add column if not exists revision_round integer not null default 0,
  add column if not exists claim_token uuid,
  add column if not exists claimed_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists last_error text,
  add column if not exists immutable_input jsonb not null default '{}'::jsonb;

alter table public.autonomous_run_checkpoints
  drop constraint if exists autonomous_run_checkpoints_status_check;
alter table public.autonomous_run_checkpoints
  add constraint autonomous_run_checkpoints_status_check
  check (status in ('active', 'queued', 'running', 'completed', 'failed', 'cancelled')) not valid;
alter table public.autonomous_run_checkpoints
  validate constraint autonomous_run_checkpoints_status_check;

alter table public.autonomous_run_checkpoints
  drop constraint if exists autonomous_run_checkpoints_transition_check;
alter table public.autonomous_run_checkpoints
  add constraint autonomous_run_checkpoints_transition_check
  check (transition in ('staff', 'specialist', 'review', 'revision', 'synth')) not valid;
alter table public.autonomous_run_checkpoints
  validate constraint autonomous_run_checkpoints_transition_check;

create index if not exists autonomous_run_worker_due_idx
  on public.autonomous_run_checkpoints (next_attempt_at, created_at)
  where status in ('queued', 'running');

create unique index if not exists autonomous_run_one_active_user_uidx
  on public.autonomous_run_checkpoints (account_id, user_id)
  where status in ('queued', 'running');

create or replace function public.claim_autonomous_run(p_lease_seconds integer default 600)
returns setof public.autonomous_run_checkpoints
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.autonomous_run_checkpoints;
begin
  with candidate as (
    select id
    from public.autonomous_run_checkpoints
    where expires_at > now()
      and attempt_count < 8
      and (
        (status = 'queued' and next_attempt_at <= now())
        or (status = 'running' and claimed_at < now() - make_interval(secs => greatest(60, least(p_lease_seconds, 1800))))
      )
    order by next_attempt_at, created_at
    for update skip locked
    limit 1
  )
  update public.autonomous_run_checkpoints r
  set status = 'running',
      claim_token = gen_random_uuid(),
      claimed_at = now(),
      attempt_count = r.attempt_count + 1,
      updated_at = now()
  from candidate
  where r.id = candidate.id
  returning r.* into claimed;

  if claimed.id is not null then return next claimed; end if;
end
$$;

create or replace function public.finish_autonomous_transition(
  p_run_id uuid,
  p_claim_token uuid,
  p_state jsonb,
  p_phase text,
  p_transition text,
  p_specialist_cursor integer,
  p_review_cursor integer,
  p_revision_round integer,
  p_status text default 'queued',
  p_last_error text default null,
  p_next_attempt_at timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status not in ('queued', 'completed', 'failed')
    or p_phase not in ('team', 'review', 'synth')
    or p_transition not in ('staff', 'specialist', 'review', 'revision', 'synth') then
    raise exception 'invalid autonomous transition';
  end if;

  update public.autonomous_run_checkpoints
  set state = p_state,
      phase = p_phase,
      transition = p_transition,
      specialist_cursor = greatest(0, p_specialist_cursor),
      review_cursor = greatest(0, p_review_cursor),
      revision_round = greatest(0, p_revision_round),
      status = p_status,
      attempt_count = case when p_last_error is null then 0 else attempt_count end,
      last_error = left(p_last_error, 2000),
      next_attempt_at = p_next_attempt_at,
      claim_token = null,
      claimed_at = null,
      updated_at = now()
  where id = p_run_id
    and status = 'running'
    and claim_token = p_claim_token;
  return found;
end
$$;

revoke all on function public.claim_autonomous_run(integer) from public, anon, authenticated;
revoke all on function public.finish_autonomous_transition(uuid,uuid,jsonb,text,text,integer,integer,integer,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_autonomous_run(integer) to service_role;
grant execute on function public.finish_autonomous_transition(uuid,uuid,jsonb,text,text,integer,integer,integer,text,text,timestamptz) to service_role;
