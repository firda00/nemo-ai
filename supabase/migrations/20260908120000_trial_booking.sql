-- Local trial booking vertical slice. No external delivery or model execution.
-- Reuses the durable inbox/workflow/policy/approval/outbox/audit and public.bookings.
-- Courses and capacity-bearing sessions are absent from the existing schema.
create table public.trial_courses (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  name text not null check (char_length(name) between 1 and 160),
  unique(account_id,id)
);
create table public.trial_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  course_id uuid not null,
  starts_at timestamptz not null,
  timezone text not null default 'Asia/Tashkent' check (timezone = 'Asia/Tashkent'),
  capacity integer not null check (capacity between 1 and 10000),
  status text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  unique(account_id,id),
  foreign key(account_id,course_id) references public.trial_courses(account_id,id)
);
alter table public.trial_courses enable row level security;
alter table public.trial_sessions enable row level security;
revoke all on public.trial_courses, public.trial_sessions from public,anon,authenticated;
-- Explicit ACLs: a fresh database need not grant new public tables by default.
-- Browser profiles remain constrained by the existing users/accounts SELECT RLS.
grant select on public.users, public.accounts to authenticated;
grant select, update on public.users to service_role;
grant select, update, delete on public.accounts to service_role;
grant select, insert, update on public.trial_courses, public.trial_sessions to service_role;
grant select on public.bookings to service_role;
alter table public.bookings add column trial_session_id uuid;
alter table public.bookings add column trial_operation_id uuid;
alter table public.bookings add constraint bookings_trial_identity_check
  check ((trial_session_id is null and trial_operation_id is null)
    or (trial_session_id is not null and account_id is not null));
alter table public.bookings add constraint bookings_trial_session_fk
  foreign key(account_id,trial_session_id) references public.trial_sessions(account_id,id);
alter table public.bookings add constraint bookings_trial_operation_fk
  foreign key(account_id,trial_operation_id) references runtime.workflow_runs(account_id,id);
create unique index bookings_trial_operation_unique on public.bookings(trial_operation_id)
  where trial_operation_id is not null;
create index bookings_trial_session_idx on public.bookings(account_id,trial_session_id);

-- The existing general approval endpoint also reaches this table. It must not weaken this action's owner policy.
create function runtime.trial_guard_approval_owner()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('approved','rejected') and new.status is distinct from old.status
    and exists(select 1 from runtime.workflow_runs where account_id=new.account_id and id=new.workflow_id and workflow_type='trial_booking') then
    perform id from public.users where id=new.decided_by and account_id=new.account_id and role='owner' for share;
    if not found then raise exception using errcode='42501',message='TRIAL_OWNER_APPROVAL_REQUIRED'; end if;
  end if;
  return new;
end $$;
create trigger trial_approval_owner before update on public.approval_requests
  for each row execute function runtime.trial_guard_approval_owner();

create function runtime.trial_assert_user(p_account_id uuid,p_owner boolean default false)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_user uuid := auth.uid();
begin
  perform id from public.accounts where id=p_account_id and not blocked and not is_production_e2e for share;
  if not found then raise exception using errcode='42501',message='TRIAL_ACCOUNT_NOT_AVAILABLE'; end if;
  if v_user is null or not exists(select 1 from public.users u
    where u.id=v_user and u.account_id=p_account_id
      and (u.role='owner' or (not p_owner and u.role='operator'))) then
    raise exception using errcode='42501',message='TRIAL_PERMISSION_DENIED';
  end if;
  return v_user;
end $$;

create function public.trial_booking_schedule(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform runtime.trial_assert_user(p_account_id);
  select coalesce(jsonb_agg(x.payload order by x.starts_at,x.id),'[]'::jsonb) into v_result from (
    select s.id,s.starts_at,jsonb_build_object('id',s.id,'course_id',c.id,'course_name',c.name,
      'starts_at',s.starts_at,'timezone',s.timezone,'capacity',s.capacity,'status',s.status,
      'available',greatest(0,s.capacity-(select count(*) from public.bookings b
        where b.account_id=p_account_id and b.trial_session_id=s.id and b.status='booked'))) payload
    from public.trial_sessions s join public.trial_courses c on c.account_id=s.account_id and c.id=s.course_id
    where s.account_id=p_account_id
  ) x;
  return v_result;
end $$;

create function public.trial_booking_result(p_account_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_run runtime.workflow_runs%rowtype; v_request public.approval_requests%rowtype; v_booking public.bookings%rowtype;
begin
  perform runtime.trial_assert_user(p_account_id);
  select * into v_run from runtime.workflow_runs where account_id=p_account_id and id=p_operation_id and workflow_type='trial_booking';
  if not found then raise exception using errcode='42501',message='TRIAL_OPERATION_NOT_ACCESSIBLE'; end if;
  if v_run.context->'proposed_action'->>'requested_by' is distinct from auth.uid()::text
    and not exists(select 1 from public.users where id=auth.uid() and account_id=p_account_id and role='owner') then
    raise exception using errcode='42501',message='TRIAL_OPERATION_NOT_ACCESSIBLE';
  end if;
  select * into v_request from public.approval_requests where account_id=p_account_id and workflow_id=p_operation_id;
  select * into v_booking from public.bookings where account_id=p_account_id and trial_operation_id=p_operation_id;
  if v_run.current_state='completed' and (v_booking.id is null or v_run.context->'result'->>'booking_id' <> v_booking.id::text) then
    raise exception using errcode='55000',message='TRIAL_RESULT_INCONSISTENT';
  end if;
  return jsonb_build_object('operation_id',v_run.id,'approval_request_id',v_request.id,
    'status',v_run.current_state,'approval_status',v_request.status,'payload',v_run.context->'proposed_action',
    'booking_id',v_booking.id,'result',v_run.context->'result');
end $$;

create function public.trial_booking_recover(p_account_id uuid,p_operation_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_id uuid;
begin
  v_user:=runtime.trial_assert_user(p_account_id);
  select w.id into v_id from runtime.workflow_runs w join runtime.inbox_events i
    on i.account_id=w.account_id and i.id=w.inbox_event_id
    where w.account_id=p_account_id and w.workflow_type='trial_booking'
      and i.provider='trial_booking' and i.external_event_id=v_user::text||':'||p_operation_key;
  if v_id is null then return null; end if;
  return public.trial_booking_result(p_account_id,v_id);
end $$;

create function public.trial_booking_recent(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_owner boolean; v_result jsonb;
begin
  v_user:=runtime.trial_assert_user(p_account_id);
  select role='owner' into v_owner from public.users where id=v_user and account_id=p_account_id;
  select coalesce(jsonb_agg(public.trial_booking_result(p_account_id,r.id) order by r.created_at desc),'[]'::jsonb)
    into v_result from (select id,created_at from runtime.workflow_runs
      where account_id=p_account_id and workflow_type='trial_booking'
        and (v_owner or context->'proposed_action'->>'requested_by'=v_user::text)
      order by created_at desc,id limit 50) r;
  return v_result;
end $$;

create function public.trial_booking_request(p_account_id uuid,p_session_id uuid,p_operation_key text,p_attendee_label text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_slot public.trial_sessions%rowtype; v_payload jsonb; v_ingest jsonb; v_id uuid;
  v_existing jsonb; v_course text; v_correlation uuid:=gen_random_uuid(); v_policy jsonb;
begin
  v_user:=runtime.trial_assert_user(p_account_id);
  if p_session_id is null or p_operation_key is null or char_length(p_operation_key) not between 8 and 128
    or p_attendee_label is null or char_length(btrim(p_attendee_label)) not between 1 and 120 then
    raise exception using errcode='22023',message='TRIAL_INVALID_INPUT';
  end if;
  -- Serialize retries before looking up existing identity; no advisory-lock hash collision can change identity.
  perform pg_advisory_xact_lock(hashtextextended(p_account_id::text||':'||v_user::text||':'||p_operation_key,0));
  v_existing:=public.trial_booking_recover(p_account_id,p_operation_key);
  if v_existing is not null then
    if v_existing->'payload'->>'session_id' <> p_session_id::text
      or v_existing->'payload'->>'attendee_label' <> btrim(p_attendee_label) then
      raise exception using errcode='22000',message='TRIAL_OPERATION_PARAMETERS_CHANGED';
    end if;
    return v_existing;
  end if;
  select * into v_slot from public.trial_sessions where account_id=p_account_id and id=p_session_id for share;
  if not found then raise exception using errcode='42501',message='TRIAL_SESSION_NOT_ACCESSIBLE'; end if;
  if v_slot.status<>'scheduled' or v_slot.starts_at<=clock_timestamp() then
    raise exception using errcode='55000',message='TRIAL_SESSION_UNAVAILABLE';
  end if;
  select name into v_course from public.trial_courses where account_id=p_account_id and id=v_slot.course_id;
  v_payload:=jsonb_build_object('action_type','trial_booking','session_id',v_slot.id,'course_id',v_slot.course_id,
    'course_name',v_course,'starts_at',v_slot.starts_at,'timezone',v_slot.timezone,'attendee_label',btrim(p_attendee_label),
    'requested_by',v_user,'account_id',p_account_id);
  v_ingest:=public.runtime_ingest_event(p_account_id,'trial_booking',v_user::text||':'||p_operation_key,
    v_payload,'live',v_correlation,p_workflow_type=>'trial_booking',p_actor_id=>v_user::text);
  v_id:=(v_ingest->>'workflow_id')::uuid;
  -- Synchronous database planning is atomic and never hands an unclaimed running job to a worker.
  insert into runtime.workflow_transitions(account_id,workflow_id,transition_seq,from_state,to_state,transition_type,
    actor_type,actor_id,correlation_id,workflow_version,lease_epoch) values
    (p_account_id,v_id,2,'queued','running','planned','user',v_user::text,v_correlation,'v1',0),
    (p_account_id,v_id,3,'running','waiting_for_policy','policy_requested','user',v_user::text,v_correlation,'v1',0);
  update runtime.workflow_runs set current_state='waiting_for_policy',context=jsonb_build_object(
    'proposed_action',v_payload,'proposed_connector_id','internal_trial_booking','proposed_action_type','trial_booking')
    where id=v_id and account_id=p_account_id;
  v_policy:=public.runtime_record_policy_decision(p_account_id,v_id,'trial-booking-owner-approval','v1','require_approval',
    '["OWNER_APPROVAL_REQUIRED"]'::jsonb,'{}'::jsonb,v_payload,v_user::text,
    p_approval_summary=>'Trial booking: '||v_course||' / '||v_slot.starts_at::text);
  return public.trial_booking_result(p_account_id,v_id);
end $$;

create function public.trial_booking_decide(p_account_id uuid,p_operation_id uuid,p_decision text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_run runtime.workflow_runs%rowtype; v_request public.approval_requests%rowtype;
begin
  v_user:=runtime.trial_assert_user(p_account_id,true);
  if p_decision is null or p_decision not in ('approve','reject') then
    raise exception using errcode='22023',message='TRIAL_INVALID_DECISION'; end if;
  select * into v_run from runtime.workflow_runs where account_id=p_account_id and id=p_operation_id and workflow_type='trial_booking' for update;
  if not found then raise exception using errcode='42501',message='TRIAL_OPERATION_NOT_ACCESSIBLE'; end if;
  select * into strict v_request from public.approval_requests where account_id=p_account_id and workflow_id=p_operation_id for update;
  if v_request.status=(case when p_decision='approve' then 'approved' else 'rejected' end) then
    return public.trial_booking_result(p_account_id,p_operation_id);
  end if;
  perform public.runtime_resolve_approval_and_enqueue_action(p_account_id,p_operation_id,v_request.id,v_user,
    case when p_decision='approve' then 'approved' else 'rejected' end,
    'internal_trial_booking','trial_booking',v_run.context->'proposed_action','trial-booking:'||p_operation_id::text);
  return public.trial_booking_result(p_account_id,p_operation_id);
end $$;

create function public.trial_booking_execute(p_account_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_run runtime.workflow_runs%rowtype; v_request public.approval_requests%rowtype;
  v_action runtime.outbox_actions%rowtype; v_slot public.trial_sessions%rowtype; v_payload jsonb;
  v_booking uuid; v_result jsonb; v_seq bigint; v_transition uuid; v_control runtime.system_controls%rowtype;
begin
  v_user:=runtime.trial_assert_user(p_account_id);
  select * into v_control from runtime.system_controls where singleton for share;
  if not found or v_control.kill_switch_active or v_control.claims_paused then
    raise exception using errcode='55000',message='TRIAL_RUNTIME_PAUSED'; end if;
  -- Order: operation, approval, outbox, session. All competing operations lock the same capacity row.
  select * into v_run from runtime.workflow_runs where account_id=p_account_id and id=p_operation_id and workflow_type='trial_booking' for update;
  if not found then raise exception using errcode='42501',message='TRIAL_OPERATION_NOT_ACCESSIBLE'; end if;
  if v_run.current_state='completed' then return public.trial_booking_result(p_account_id,p_operation_id); end if;
  select * into strict v_request from public.approval_requests where account_id=p_account_id and workflow_id=p_operation_id for update;
  if v_run.current_state<>'waiting_for_action' or v_request.status<>'approved' or v_request.expires_at<=clock_timestamp() then
    raise exception using errcode='55000',message='TRIAL_APPROVAL_REQUIRED'; end if;
  v_payload:=v_run.context->'proposed_action';
  -- Hold all authorization rows until commit. Revocation cannot race between revalidation and insert.
  perform id from public.users where id in (v_user,(v_payload->>'requested_by')::uuid,v_request.decided_by)
    order by id for share;
  perform runtime.trial_assert_user(p_account_id);
  if v_payload->>'requested_by' is distinct from v_user::text
    and not exists(select 1 from public.users where id=v_user and account_id=p_account_id and role='owner') then
    raise exception using errcode='42501',message='TRIAL_OPERATION_NOT_ACCESSIBLE';
  end if;
  if not exists(select 1 from public.users where id=(v_payload->>'requested_by')::uuid and account_id=p_account_id and role in ('owner','operator'))
    or not exists(select 1 from public.users where id=v_request.decided_by and account_id=p_account_id and role='owner') then
    raise exception using errcode='42501',message='TRIAL_PERMISSION_REVOKED'; end if;
  select * into strict v_action from runtime.outbox_actions where id=v_request.outbox_action_id and account_id=p_account_id and workflow_id=p_operation_id for update;
  if v_action.connector_id<>'internal_trial_booking' or v_action.action_type<>'trial_booking' or v_action.status<>'pending'
    or v_action.execution_mode<>'live' or v_action.payload<>v_payload or runtime.sha256_jsonb(v_payload)<>v_request.action_payload_hash
    or runtime.sha256_jsonb(v_payload)<>v_action.action_payload_hash then
    raise exception using errcode='55000',message='TRIAL_ACTION_NOT_EXECUTABLE'; end if;
  select * into v_slot from public.trial_sessions where account_id=p_account_id and id=(v_payload->>'session_id')::uuid for update;
  if not found or v_slot.status<>'scheduled' or v_slot.starts_at<=clock_timestamp() or v_slot.starts_at<>(v_payload->>'starts_at')::timestamptz
    or v_slot.course_id<>(v_payload->>'course_id')::uuid or v_slot.timezone<>(v_payload->>'timezone') then
    raise exception using errcode='55000',message='TRIAL_SESSION_CHANGED_OR_UNAVAILABLE'; end if;
  if (select count(*) from public.bookings where account_id=p_account_id and trial_session_id=v_slot.id and status='booked')>=v_slot.capacity then
    raise exception using errcode='55000',message='TRIAL_SESSION_FULL'; end if;
  insert into public.bookings(account_id,customer_name,service,scheduled_at,scheduled_text,status,trial_session_id,trial_operation_id)
    values(p_account_id,v_payload->>'attendee_label',v_payload->>'course_name',v_slot.starts_at,
      (v_slot.starts_at at time zone 'Asia/Tashkent')::text||' Asia/Tashkent','booked',v_slot.id,p_operation_id) returning id into v_booking;
  v_result:=jsonb_build_object('booking_id',v_booking,'session_id',v_slot.id,'starts_at',v_slot.starts_at,'timezone',v_slot.timezone,'status','booked');
  select coalesce(max(transition_seq),0)+1 into v_seq from runtime.workflow_transitions where account_id=p_account_id and workflow_id=p_operation_id;
  insert into runtime.workflow_transitions(account_id,workflow_id,transition_seq,from_state,to_state,transition_type,actor_type,actor_id,
    correlation_id,workflow_version,policy_version,lease_epoch,transition_payload)
    values(p_account_id,p_operation_id,v_seq,'waiting_for_action','completed','action_completed','user',v_user::text,
      v_run.correlation_id,v_run.workflow_version,v_action.policy_version,v_run.lease_epoch,v_result) returning id into v_transition;
  update runtime.outbox_actions set status='completed',completed_at=clock_timestamp(),provider_result_ref=v_booking::text,
    attempt_count=attempt_count+1,updated_at=clock_timestamp() where id=v_action.id;
  update runtime.workflow_runs set current_state='completed',terminal_at=clock_timestamp(),context=context||jsonb_build_object('result',v_result),
    updated_at=clock_timestamp() where id=p_operation_id;
  -- Mandatory append-only audit is in the same transaction. Any audit failure rolls back the booking and completion.
  insert into runtime.audit_events(account_id,workflow_id,transition_id,policy_decision_id,approval_request_id,outbox_action_id,
    event_type,actor_type,actor_id,correlation_id,details,payload_hash,runtime_contract_version,workflow_version,policy_version)
    values(p_account_id,p_operation_id,v_transition,v_action.policy_decision_id,v_request.id,v_action.id,'trial.booking_created',
      'user',v_user::text,v_run.correlation_id,v_result,runtime.sha256_jsonb(v_payload),'runtime-v1',v_run.workflow_version,v_action.policy_version);
  return jsonb_build_object('operation_id',p_operation_id,'status','execution_saved');
  -- Caller MUST issue trial_booking_result separately before chat confirmation.
end $$;

revoke all on function runtime.trial_assert_user(uuid,boolean) from public,anon,authenticated;
revoke all on function runtime.trial_guard_approval_owner() from public,anon,authenticated;
revoke all on function public.trial_booking_schedule(uuid),public.trial_booking_result(uuid,uuid),
  public.trial_booking_recent(uuid),public.trial_booking_recover(uuid,text),public.trial_booking_request(uuid,uuid,text,text),
  public.trial_booking_decide(uuid,uuid,text),public.trial_booking_execute(uuid,uuid) from public,anon;
grant execute on function public.trial_booking_schedule(uuid),public.trial_booking_result(uuid,uuid),
  public.trial_booking_recent(uuid),public.trial_booking_recover(uuid,text),public.trial_booking_request(uuid,uuid,text,text),
  public.trial_booking_decide(uuid,uuid,text),public.trial_booking_execute(uuid,uuid) to authenticated;

-- Preserve the existing fenced/kill-switch-aware worker path; internal SQL actions have their own atomic executor.
create or replace function public.runtime_claim_outbox_actions(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_connector_id text default null
)
returns table (
  account_id uuid,
  outbox_action_id uuid,
  workflow_id uuid,
  connector_id text,
  action_type text,
  payload jsonb,
  idempotency_key text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_action runtime.outbox_actions%rowtype;
  v_token uuid;
  v_epoch bigint;
  v_until timestamptz;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid outbox lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid outbox claim limit';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then
    return;
  end if;

  for v_action in
    select action.*
    from runtime.outbox_actions as action
    where action.execution_mode = 'live'
      and action.connector_id <> 'internal_trial_booking'
      and action.attempt_count < action.max_attempts
      and (p_connector_id is null or action.connector_id = p_connector_id)
      and (
        action.status = 'pending'
        or (action.status = 'retry_scheduled' and action.next_attempt_at <= clock_timestamp())
        or (action.status = 'processing' and action.lease_until <= clock_timestamp())
      )
      and not exists (
        select 1 from runtime.connector_health as health
        where health.account_id = action.account_id
          and health.connector_id = action.connector_id
          and health.operation = action.action_type
          -- Fail closed. A separate health controller must explicitly close the circuit after a
          -- bounded half-open probe; normal action workers never bypass open/half-open state.
          and health.state in ('open', 'half_open')
      )
    order by coalesce(action.next_attempt_at, action.created_at), action.created_at, action.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_epoch := v_action.lease_epoch + 1;
    v_until := clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds);

    update runtime.outbox_actions as action
    set status = 'processing', claimed_at = clock_timestamp(), lease_until = v_until,
        claim_token = v_token, lease_epoch = v_epoch,
        attempt_count = action.attempt_count + 1, next_attempt_at = null,
        completed_at = null, updated_at = clock_timestamp()
    where action.account_id = v_action.account_id and action.id = v_action.id;

    insert into runtime.audit_events (
      account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
      outbox_action_id, event_type, actor_type, actor_id, correlation_id,
      details, payload_hash, runtime_contract_version, policy_version
    )
    select action.account_id, action.workflow_id, action.transition_id,
      action.policy_decision_id, action.approval_request_id, action.id,
      'runtime.outbox_claimed', 'worker', p_worker_id, run.correlation_id,
      pg_catalog.jsonb_build_object('lease_epoch', v_epoch, 'lease_until', v_until),
      action.action_payload_hash, 'runtime-v1', action.policy_version
    from runtime.outbox_actions as action
    join runtime.workflow_runs as run
      on run.account_id = action.account_id and run.id = action.workflow_id
    where action.account_id = v_action.account_id and action.id = v_action.id;

    return query
    select action.account_id, action.id, action.workflow_id, action.connector_id,
      action.action_type, action.payload, action.idempotency_key,
      action.claim_token, action.lease_epoch, action.lease_until, action.attempt_count
    from runtime.outbox_actions as action
    where action.account_id = v_action.account_id and action.id = v_action.id;
  end loop;
end
$$;


