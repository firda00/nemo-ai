-- Goal-conditioned autonomous execution adds a deterministic goal-check state
-- between peer review and final synthesis. State remains JSONB so existing rows
-- and clients stay compatible; only the transition allow-list changes.
alter table public.autonomous_run_checkpoints
  drop constraint if exists autonomous_run_checkpoints_transition_check;
alter table public.autonomous_run_checkpoints
  add constraint autonomous_run_checkpoints_transition_check
  check (transition in ('staff', 'observe_plan', 'specialist', 'review', 'revision', 'goal_check', 'synth')) not valid;
alter table public.autonomous_run_checkpoints
  validate constraint autonomous_run_checkpoints_transition_check;

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
    or p_transition not in ('staff', 'observe_plan', 'specialist', 'review', 'revision', 'goal_check', 'synth') then
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

revoke all on function public.finish_autonomous_transition(uuid,uuid,jsonb,text,text,integer,integer,integer,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.finish_autonomous_transition(uuid,uuid,jsonb,text,text,integer,integer,integer,text,text,timestamptz) to service_role;
