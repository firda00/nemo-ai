-- Review hardening: recover abandoned half-open probes and expose the persisted attempt limit.

create or replace function public.runtime_acquire_connector_permit(
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
  v_retry_at timestamptz;
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

  -- Expiry is consumed under the same connector-health row lock as state recovery. This makes a
  -- probe crash self-healing while preserving the one-live-probe partial unique index.
  update runtime.connector_permits
  set consumed_at = v_now
  where account_id = p_account_id
    and connector_health_id = v_health.id
    and consumed_at is null
    and expires_at <= v_now;

  if v_health.state = 'half_open' and not exists (
    select 1
    from runtime.connector_permits as permit
    where permit.account_id = p_account_id
      and permit.connector_health_id = v_health.id
      and permit.is_probe
      and permit.permit_token = v_health.half_open_probe_token
      and permit.consumed_at is null
      and permit.expires_at > v_now
  ) then
    v_retry_at := v_now + pg_catalog.make_interval(secs => v_health.cooldown_seconds);
    update runtime.connector_health
    set state = 'open',
        opened_until = v_retry_at,
        half_open_probe_token = null,
        updated_at = v_now
    where account_id = p_account_id and id = v_health.id;
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'state', 'open',
      'retry_at', v_retry_at,
      'recovered_abandoned_probe', true
    );
  end if;

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

-- PostgreSQL cannot change a TABLE return shape with CREATE OR REPLACE. Recreate the one canonical
-- overload and immediately restore its service-role-only grant.
drop function public.runtime_claim_workflow(text, integer, integer, text, text);

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
  max_attempts integer,
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
  if v_control.kill_switch_active or v_control.claims_paused then return; end if;

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
      run.max_attempts, run.context, event.event_type, event.payload
    from runtime.workflow_runs as run
    join runtime.inbox_events as event
      on event.account_id = run.account_id and event.id = run.inbox_event_id
    where run.account_id = v_run.account_id and run.id = v_run.id;
  end loop;
end
$$;

revoke all on function public.runtime_claim_workflow(text, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.runtime_claim_workflow(text, integer, integer, text, text)
  to service_role;

comment on function public.runtime_acquire_connector_permit(uuid, text, text, integer)
  is 'Issues fenced connector permits and self-heals abandoned half-open probes after permit expiry.';
comment on function public.runtime_claim_workflow(text, integer, integer, text, text)
  is 'Claims fenced workflow leases and returns the persisted attempt limit for exhaustion handling.';
