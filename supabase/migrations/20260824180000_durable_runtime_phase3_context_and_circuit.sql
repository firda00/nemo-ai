-- Durable Operations Runtime Phase 3A: typed claims, context checkpoints, and fenced connector permits.

drop function if exists public.runtime_claim_workflow(text, integer, integer, text);

create function public.runtime_claim_workflow(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_execution_mode text default null,
  p_workflow_type text default null
)
returns table (
  account_id uuid,
  workflow_id uuid,
  inbox_event_id uuid,
  workflow_type text,
  workflow_version text,
  execution_mode text,
  correlation_id uuid,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer,
  context jsonb,
  event_type text,
  payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_token uuid;
  v_epoch bigint;
  v_seq bigint;
  v_until timestamptz;
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid workflow lease duration';
  end if;
  if p_limit not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid workflow claim limit';
  end if;
  if p_execution_mode is not null and p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'invalid execution mode filter';
  end if;
  if p_workflow_type is not null and (
    char_length(p_workflow_type) not between 1 and 128
    or p_workflow_type !~ '^[a-z][a-z0-9_]{0,127}$'
  ) then
    raise exception using errcode = '22023', message = 'invalid workflow type filter';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;

  if v_control.kill_switch_active or v_control.claims_paused then
    return;
  end if;

  for v_run in
    select run.*
    from runtime.workflow_runs as run
    where run.attempt_count < run.max_attempts
      and (p_execution_mode is null or run.execution_mode = p_execution_mode)
      and (p_workflow_type is null or run.workflow_type = p_workflow_type)
      and (
        run.current_state = 'queued'
        or (run.current_state = 'retry_scheduled' and run.next_attempt_at <= clock_timestamp())
        or (run.current_state = 'running' and run.lease_until <= clock_timestamp())
      )
    order by coalesce(run.next_attempt_at, run.created_at), run.created_at, run.id
    for update skip locked
    limit p_limit
  loop
    v_token := gen_random_uuid();
    v_epoch := v_run.lease_epoch + 1;
    v_until := clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds);

    select coalesce(max(t.transition_seq), 0) into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = v_run.account_id and t.workflow_id = v_run.id;

    if v_run.current_state = 'retry_scheduled' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'retry_scheduled', 'queued',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    if v_run.current_state <> 'running' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, claim_token, lease_epoch
      ) values (
        v_run.account_id, v_run.id, v_seq, 'queued', 'running',
        'recovered', 'worker', p_worker_id, v_run.correlation_id,
        v_run.workflow_version, v_token, v_epoch
      );
    end if;

    update runtime.workflow_runs as run
    set current_state = 'running',
        lease_holder = p_worker_id,
        lease_until = v_until,
        claim_token = v_token,
        lease_epoch = v_epoch,
        attempt_count = run.attempt_count + 1,
        next_attempt_at = null,
        updated_at = clock_timestamp()
    where run.account_id = v_run.account_id and run.id = v_run.id;

    insert into runtime.audit_events (
      account_id, workflow_id, event_type, actor_type, actor_id,
      correlation_id, details, runtime_contract_version, workflow_version
    ) values (
      v_run.account_id, v_run.id, 'runtime.workflow_claimed',
      'worker', p_worker_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'lease_epoch', v_epoch,
        'lease_until', v_until,
        'workflow_type_filter', p_workflow_type,
        'reclaimed_expired_lease', v_run.current_state = 'running'
      ),
      'runtime-v1', v_run.workflow_version
    );

    return query
    select run.account_id, run.id, run.inbox_event_id, run.workflow_type,
      run.workflow_version, run.execution_mode, run.correlation_id,
      run.claim_token, run.lease_epoch, run.lease_until, run.attempt_count,
      run.context, event.event_type, event.payload
    from runtime.workflow_runs as run
    join runtime.inbox_events as event
      on event.account_id = run.account_id and event.id = run.inbox_event_id
    where run.account_id = v_run.account_id and run.id = v_run.id;
  end loop;
end
$$;

create function public.runtime_checkpoint_and_transition(
  p_account_id uuid,
  p_workflow_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_context_patch jsonb,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_context jsonb;
  v_transition_id uuid;
  v_seq bigint;
  v_patch_hash text;
begin
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid checkpoint actor';
  end if;
  if p_context_patch is null or pg_catalog.jsonb_typeof(p_context_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'context patch must be a JSON object';
  end if;
  if pg_catalog.octet_length(p_context_patch::text) > 65536 then
    raise exception using errcode = '22023', message = 'context patch exceeds size limit';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'running'
    or v_run.lease_epoch <> p_expected_epoch
    or v_run.claim_token is distinct from p_claim_token
    or v_run.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid workflow lease';
  end if;

  if not exists (
    select 1 from runtime.allowed_workflow_transitions as allowed
    where allowed.from_state = 'running' and allowed.to_state = 'waiting_for_policy'
  ) then
    raise exception using errcode = '55000', message = 'required workflow transition is unavailable';
  end if;

  v_context := v_run.context || p_context_patch;
  if pg_catalog.octet_length(v_context::text) > 65536 then
    raise exception using errcode = '22023', message = 'merged workflow context exceeds size limit';
  end if;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;
  v_patch_hash := runtime.sha256_jsonb(p_context_patch);

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, claim_token, lease_epoch, transition_payload, payload_hash
  ) values (
    p_account_id, p_workflow_id, v_seq, 'running', 'waiting_for_policy',
    'checkpoint_saved', 'worker', p_actor_id, v_run.correlation_id,
    v_run.workflow_version, p_claim_token, p_expected_epoch, p_context_patch, v_patch_hash
  ) returning id into v_transition_id;

  update runtime.workflow_runs as run
  set current_state = 'waiting_for_policy',
      context = v_context,
      lease_holder = null,
      lease_until = null,
      claim_token = null,
      updated_at = clock_timestamp()
  where run.account_id = p_account_id and run.id = p_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, event_type, actor_type, actor_id,
    correlation_id, details, payload_hash, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, 'runtime.context_checkpointed',
    'worker', p_actor_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object('from_state', 'running', 'to_state', 'waiting_for_policy'),
    v_patch_hash, 'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'checkpointed',
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'state', 'waiting_for_policy',
    'context', v_context
  );
end
$$;

create table runtime.connector_permits (
  permit_token uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  connector_health_id uuid not null,
  connector_id text not null,
  operation text not null,
  is_probe boolean not null default false,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint connector_permits_health_fkey foreign key (account_id, connector_health_id)
    references runtime.connector_health(account_id, id) on delete restrict,
  constraint connector_permits_shape_check check (
    char_length(connector_id) between 1 and 160
    and char_length(operation) between 1 and 128
    and expires_at > created_at
  )
);

create unique index connector_permits_one_live_probe_idx
  on runtime.connector_permits (account_id, connector_health_id)
  where is_probe and consumed_at is null;

create index connector_permits_expiry_idx
  on runtime.connector_permits (expires_at)
  where consumed_at is null;

create function public.runtime_acquire_connector_permit(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_ttl_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_health runtime.connector_health%rowtype;
  v_token uuid;
  v_is_probe boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_connector_id is null or char_length(p_connector_id) not between 1 and 160
    or p_operation is null or char_length(p_operation) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'invalid connector permit identity';
  end if;
  if p_permit_ttl_seconds not between 5 and 300 then
    raise exception using errcode = '22023', message = 'invalid connector permit ttl';
  end if;

  insert into runtime.connector_health (account_id, connector_id, operation)
  values (p_account_id, p_connector_id, p_operation)
  on conflict (account_id, connector_id, operation) do nothing;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id
    and health.connector_id = p_connector_id
    and health.operation = p_operation
  for update;

  update runtime.connector_permits
  set consumed_at = v_now
  where account_id = p_account_id
    and connector_health_id = v_health.id
    and consumed_at is null
    and expires_at <= v_now;

  if v_health.state = 'open' and v_health.opened_until > v_now then
    return pg_catalog.jsonb_build_object(
      'allowed', false, 'state', 'open', 'retry_at', v_health.opened_until
    );
  end if;

  if v_health.state = 'half_open' then
    return pg_catalog.jsonb_build_object(
      'allowed', false, 'state', 'half_open', 'retry_at', v_health.opened_until
    );
  end if;

  v_token := gen_random_uuid();
  if v_health.state = 'open' then
    v_is_probe := true;
    update runtime.connector_health
    set state = 'half_open', half_open_probe_token = v_token, updated_at = v_now
    where account_id = p_account_id and id = v_health.id;
  end if;

  insert into runtime.connector_permits (
    permit_token, account_id, connector_health_id, connector_id, operation,
    is_probe, expires_at
  ) values (
    v_token, p_account_id, v_health.id, p_connector_id, p_operation,
    v_is_probe, v_now + pg_catalog.make_interval(secs => p_permit_ttl_seconds)
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'state', case when v_is_probe then 'half_open' else 'closed' end,
    'permit_token', v_token,
    'probe_token', case when v_is_probe then v_token else null end,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_permit_ttl_seconds)
  );
end
$$;

create function public.runtime_record_connector_success(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_permit runtime.connector_permits%rowtype;
  v_health runtime.connector_health%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select permit.* into strict v_permit
  from runtime.connector_permits as permit
  where permit.account_id = p_account_id
    and permit.permit_token = p_permit_token
    and permit.connector_id = p_connector_id
    and permit.operation = p_operation
  for update;
  if v_permit.consumed_at is not null or v_permit.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'invalid or expired connector permit';
  end if;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id and health.id = v_permit.connector_health_id
  for update;
  if v_permit.is_probe and (
    v_health.state <> 'half_open' or v_health.half_open_probe_token is distinct from p_permit_token
  ) then
    raise exception using errcode = '55000', message = 'stale connector probe';
  end if;

  update runtime.connector_permits set consumed_at = v_now
  where permit_token = p_permit_token;
  update runtime.connector_health
  set state = 'closed', consecutive_failures = 0,
      failure_window_started_at = null, opened_until = null,
      half_open_probe_token = null, last_success_at = v_now, updated_at = v_now
  where account_id = p_account_id and id = v_health.id;

  return pg_catalog.jsonb_build_object('status', 'recorded', 'state', 'closed');
end
$$;

create function public.runtime_record_connector_failure(
  p_account_id uuid,
  p_connector_id text,
  p_operation text,
  p_permit_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_permit runtime.connector_permits%rowtype;
  v_health runtime.connector_health%rowtype;
  v_now timestamptz := clock_timestamp();
  v_failures integer;
  v_open boolean;
  v_until timestamptz;
begin
  if p_error_code is null or p_error_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid connector error code';
  end if;
  select permit.* into strict v_permit
  from runtime.connector_permits as permit
  where permit.account_id = p_account_id
    and permit.permit_token = p_permit_token
    and permit.connector_id = p_connector_id
    and permit.operation = p_operation
  for update;
  if v_permit.consumed_at is not null or v_permit.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'invalid or expired connector permit';
  end if;

  select health.* into strict v_health
  from runtime.connector_health as health
  where health.account_id = p_account_id and health.id = v_permit.connector_health_id
  for update;
  if v_permit.is_probe and (
    v_health.state <> 'half_open' or v_health.half_open_probe_token is distinct from p_permit_token
  ) then
    raise exception using errcode = '55000', message = 'stale connector probe';
  end if;

  v_failures := v_health.consecutive_failures + 1;
  v_open := v_permit.is_probe or v_failures >= v_health.failure_threshold;
  v_until := case when v_open
    then v_now + pg_catalog.make_interval(secs => v_health.cooldown_seconds)
    else null end;

  update runtime.connector_permits set consumed_at = v_now
  where permit_token = p_permit_token;
  update runtime.connector_health
  set state = case when v_open then 'open' else 'closed' end,
      consecutive_failures = v_failures,
      failure_window_started_at = coalesce(failure_window_started_at, v_now),
      opened_until = v_until,
      half_open_probe_token = null,
      last_failure_at = v_now,
      tripped_at = case when v_open then v_now else tripped_at end,
      updated_at = v_now
  where account_id = p_account_id and id = v_health.id;

  return pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'state', case when v_open then 'open' else 'closed' end,
    'consecutive_failures', v_failures,
    'retry_at', v_until
  );
end
$$;

revoke all on table runtime.connector_permits from public, anon, authenticated;
revoke all on function public.runtime_claim_workflow(text, integer, integer, text, text)
  from public, anon, authenticated;
revoke all on function public.runtime_checkpoint_and_transition(uuid, uuid, bigint, uuid, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.runtime_acquire_connector_permit(uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.runtime_record_connector_success(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.runtime_record_connector_failure(uuid, text, text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.runtime_claim_workflow(text, integer, integer, text, text)
  to service_role;
grant execute on function public.runtime_checkpoint_and_transition(uuid, uuid, bigint, uuid, jsonb, text)
  to service_role;
grant execute on function public.runtime_acquire_connector_permit(uuid, text, text, integer)
  to service_role;
grant execute on function public.runtime_record_connector_success(uuid, text, text, uuid)
  to service_role;
grant execute on function public.runtime_record_connector_failure(uuid, text, text, uuid, text)
  to service_role;

comment on function public.runtime_claim_workflow(text, integer, integer, text, text)
  is 'Claims fenced workflow leases with optional execution-mode and validated workflow-type filters.';
comment on function public.runtime_checkpoint_and_transition(uuid, uuid, bigint, uuid, jsonb, text)
  is 'Atomically shallow-merges a bounded context patch and moves a fenced running workflow to policy review.';
comment on table runtime.connector_permits
  is 'Short-lived, single-use fencing permits for connector calls; half-open breakers admit exactly one probe.';
