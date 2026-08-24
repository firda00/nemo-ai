-- ADR 001 / Durable Operations Runtime v1 / Phase 2
-- Service-role-only public RPC wrappers for ingestion, workflow leasing, policy decisions and
-- outbox execution. The runtime schema remains private; callers never receive table privileges.

create function runtime.sha256_text(p_value text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256'),
    'hex'
  )
$$;

create function runtime.sha256_jsonb(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select runtime.sha256_text(p_value::text)
$$;

revoke all on function runtime.sha256_text(text) from public, anon, authenticated;
revoke all on function runtime.sha256_jsonb(jsonb) from public, anon, authenticated;

create function public.runtime_ingest_event(
  p_account_id uuid,
  p_provider text,
  p_external_event_id text,
  p_payload jsonb,
  p_execution_mode text,
  p_correlation_id uuid,
  p_event_type text default 'unknown',
  p_occurred_at timestamptz default clock_timestamp(),
  p_contract_version text default 'runtime-ingest-v1',
  p_identity_version text default 'v1',
  p_workflow_type text default null,
  p_workflow_version text default 'v1',
  p_actor_id text default 'runtime-ingest'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_inbox_id uuid;
  v_workflow_id uuid;
  v_transition_id uuid;
  v_external_hash text;
  v_payload_hash text;
  v_workflow_type text;
  v_created boolean := false;
begin
  if p_account_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'missing runtime identity';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'payload must be a JSON object';
  end if;
  if p_execution_mode not in ('shadow', 'live') then
    raise exception using errcode = '22023', message = 'invalid execution mode';
  end if;
  if p_occurred_at is null then
    raise exception using errcode = '22023', message = 'missing occurrence time';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid runtime actor';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;

  if v_control.kill_switch_active or v_control.ingestion_paused then
    raise exception using errcode = '55000', message = 'runtime ingestion is paused';
  end if;

  v_external_hash := runtime.sha256_text(p_external_event_id);
  v_payload_hash := runtime.sha256_jsonb(p_payload);
  v_workflow_type := coalesce(nullif(p_workflow_type, ''), p_provider || '_event');

  insert into runtime.inbox_events (
    account_id, provider, event_type, external_event_id, external_event_id_hash,
    identity_version, correlation_id, occurred_at, contract_version,
    normalization_result, payload, payload_hash
  ) values (
    p_account_id, p_provider, p_event_type, p_external_event_id, v_external_hash,
    p_identity_version, p_correlation_id, p_occurred_at, p_contract_version,
    'accepted', p_payload, v_payload_hash
  )
  on conflict (account_id, provider, identity_version, external_event_id_hash) do nothing
  returning id into v_inbox_id;

  if v_inbox_id is null then
    select event.id into strict v_inbox_id
    from runtime.inbox_events as event
    where event.account_id = p_account_id
      and event.provider = p_provider
      and event.identity_version = p_identity_version
      and event.external_event_id_hash = v_external_hash;

    if not exists (
      select 1
      from runtime.inbox_events as event
      where event.account_id = p_account_id
        and event.id = v_inbox_id
        and event.external_event_id = p_external_event_id
    ) then
      raise exception using errcode = '23000', message = 'event identity hash collision';
    end if;

    select run.id into v_workflow_id
    from runtime.workflow_runs as run
    where run.account_id = p_account_id
      and run.inbox_event_id = v_inbox_id
    order by run.created_at, run.id
    limit 1;

    if v_workflow_id is null then
      raise exception using errcode = '40001', message = 'duplicate event workflow is unavailable';
    end if;

    return pg_catalog.jsonb_build_object(
      'status', 'duplicate',
      'workflow_id', v_workflow_id,
      'inbox_event_id', v_inbox_id
    );
  end if;

  v_created := true;

  insert into runtime.workflow_runs (
    account_id, inbox_event_id, workflow_type, workflow_version,
    execution_mode, correlation_id, current_state
  ) values (
    p_account_id, v_inbox_id, v_workflow_type, p_workflow_version,
    p_execution_mode, p_correlation_id, 'received'
  )
  returning id into v_workflow_id;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, lease_epoch, transition_payload, payload_hash
  ) values (
    p_account_id, v_workflow_id, 1, 'received', 'queued',
    'ingested', 'system', p_actor_id, p_correlation_id,
    p_workflow_version, 0,
    pg_catalog.jsonb_build_object('inbox_event_id', v_inbox_id),
    runtime.sha256_jsonb(pg_catalog.jsonb_build_object('inbox_event_id', v_inbox_id))
  )
  returning id into v_transition_id;

  update runtime.workflow_runs
  set current_state = 'queued', updated_at = clock_timestamp()
  where account_id = p_account_id and id = v_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, event_type, actor_type, actor_id,
    correlation_id, details, payload_hash, runtime_contract_version, workflow_version
  ) values (
    p_account_id, v_workflow_id, v_transition_id, 'runtime.event_ingested',
    'system', p_actor_id, p_correlation_id,
    pg_catalog.jsonb_build_object(
      'provider', p_provider,
      'event_type', p_event_type,
      'execution_mode', p_execution_mode
    ),
    v_payload_hash, 'runtime-v1', p_workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', case when v_created then 'created' else 'duplicate' end,
    'workflow_id', v_workflow_id,
    'inbox_event_id', v_inbox_id
  );
end
$$;

create function public.runtime_claim_workflow(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 1,
  p_execution_mode text default null
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

    -- An expired running row is reclaimed in-place: its state does not change, but the new epoch
    -- and token fence the zombie worker. Queued/retry rows have a real queued -> running change.
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

create function public.runtime_transition_workflow(
  p_account_id uuid,
  p_workflow_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_to_state text,
  p_payload jsonb,
  p_actor_id text,
  p_transition_type text default 'checkpoint_saved',
  p_next_attempt_at timestamptz default null,
  p_error_code text default null,
  p_sanitized_error_message text default null,
  p_error_evidence_ref text default null,
  p_terminal_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_transition_id uuid;
  v_seq bigint;
  v_payload_hash text;
  v_terminal boolean;
begin
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid transition actor';
  end if;
  if p_payload is not null and pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'transition payload must be a JSON object';
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
    where allowed.from_state = v_run.current_state and allowed.to_state = p_to_state
  ) then
    raise exception using errcode = '22023', message = 'invalid workflow state transition';
  end if;

  if p_to_state = 'retry_scheduled' and p_next_attempt_at is null then
    raise exception using errcode = '22023', message = 'retry transition requires next attempt time';
  end if;
  if p_to_state <> 'retry_scheduled' and p_next_attempt_at is not null then
    raise exception using errcode = '22023', message = 'unexpected next attempt time';
  end if;

  v_terminal := p_to_state in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled');
  if v_terminal and p_to_state <> 'completed' and p_terminal_reason_code is null then
    raise exception using errcode = '22023', message = 'terminal transition requires reason code';
  end if;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

  v_payload_hash := case when p_payload is null then null else runtime.sha256_jsonb(p_payload) end;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, claim_token, lease_epoch,
    transition_payload, payload_hash, evidence_ref
  ) values (
    p_account_id, p_workflow_id, v_seq, v_run.current_state, p_to_state,
    p_transition_type, 'worker', p_actor_id, v_run.correlation_id,
    v_run.workflow_version, p_claim_token, p_expected_epoch,
    p_payload, v_payload_hash, p_error_evidence_ref
  ) returning id into v_transition_id;

  update runtime.workflow_runs as run
  set current_state = p_to_state,
      lease_holder = null,
      lease_until = null,
      claim_token = null,
      next_attempt_at = case when p_to_state = 'retry_scheduled' then p_next_attempt_at else null end,
      last_error_code = p_error_code,
      sanitized_error_message = p_sanitized_error_message,
      error_evidence_ref = p_error_evidence_ref,
      terminal_reason_code = case when v_terminal and p_to_state <> 'completed'
        then p_terminal_reason_code else null end,
      terminal_at = case when v_terminal then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where run.account_id = p_account_id and run.id = p_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, event_type, actor_type, actor_id,
    correlation_id, details, payload_hash, runtime_contract_version, workflow_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, 'runtime.workflow_transitioned',
    'worker', p_actor_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object('from_state', v_run.current_state, 'to_state', p_to_state),
    v_payload_hash, 'runtime-v1', v_run.workflow_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'transitioned',
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'state', p_to_state
  );
end
$$;

create function public.runtime_record_policy_decision(
  p_account_id uuid,
  p_workflow_id uuid,
  p_ruleset_id text,
  p_policy_version text,
  p_decision text,
  p_reasons jsonb,
  p_policy_input jsonb,
  p_action_payload jsonb,
  p_actor_id text,
  p_canonicalization_version text default 'postgres-jsonb-v1',
  p_evidence_ref text default null,
  p_approval_summary text default null,
  p_approval_ttl_seconds integer default 86400
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_to_state text;
  v_transition_id uuid;
  v_policy_id uuid;
  v_approval_id uuid;
  v_seq bigint;
  v_input_hash text;
  v_action_hash text;
begin
  if p_decision not in ('allow', 'deny', 'require_approval') then
    raise exception using errcode = '22023', message = 'invalid policy decision';
  end if;
  if p_reasons is null or pg_catalog.jsonb_typeof(p_reasons) <> 'array'
    or p_policy_input is null or pg_catalog.jsonb_typeof(p_policy_input) <> 'object'
    or p_action_payload is null or pg_catalog.jsonb_typeof(p_action_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid policy payload shape';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid policy actor';
  end if;
  if p_approval_ttl_seconds not between 60 and 2592000 then
    raise exception using errcode = '22023', message = 'invalid approval ttl';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'waiting_for_policy' then
    raise exception using errcode = '55000', message = 'workflow is not waiting for policy';
  end if;

  v_to_state := case p_decision
    when 'allow' then 'waiting_for_action'
    when 'require_approval' then 'waiting_for_approval'
    else 'denied'
  end;
  v_input_hash := runtime.sha256_jsonb(p_policy_input);
  v_action_hash := runtime.sha256_jsonb(p_action_payload);

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

  insert into runtime.workflow_transitions (
    account_id, workflow_id, transition_seq, from_state, to_state,
    transition_type, actor_type, actor_id, correlation_id,
    workflow_version, policy_version, lease_epoch, transition_payload,
    payload_hash, evidence_ref
  ) values (
    p_account_id, p_workflow_id, v_seq, 'waiting_for_policy', v_to_state,
    'policy_decided', 'system', p_actor_id, v_run.correlation_id,
    v_run.workflow_version, p_policy_version, v_run.lease_epoch,
    pg_catalog.jsonb_build_object('decision', p_decision, 'reasons', p_reasons),
    v_input_hash, p_evidence_ref
  ) returning id into v_transition_id;

  insert into runtime.policy_decisions (
    account_id, workflow_id, transition_id, ruleset_id, policy_version,
    decision, reasons, input_hash, action_payload_hash,
    canonicalization_version, evidence_ref
  ) values (
    p_account_id, p_workflow_id, v_transition_id, p_ruleset_id, p_policy_version,
    p_decision, p_reasons, v_input_hash, v_action_hash,
    p_canonicalization_version, p_evidence_ref
  ) returning id into v_policy_id;

  if p_decision = 'require_approval' then
    insert into public.approval_requests (
      account_id, source, action_type, summary, evidence, status, expires_at,
      workflow_id, transition_id, policy_decision_id, policy_version,
      action_canonicalization_version, action_payload_hash
    ) values (
      p_account_id, 'workflow', 'runtime_external_action',
      left(coalesce(nullif(p_approval_summary, ''), 'Runtime action requires approval'), 240),
      pg_catalog.jsonb_build_object(
        'workflow_id', p_workflow_id,
        'policy_decision_id', v_policy_id,
        'action_payload_hash', v_action_hash
      ),
      'pending', clock_timestamp() + pg_catalog.make_interval(secs => p_approval_ttl_seconds),
      p_workflow_id, v_transition_id, v_policy_id, p_policy_version,
      p_canonicalization_version, v_action_hash
    ) returning id into v_approval_id;
  end if;

  update runtime.workflow_runs as run
  set current_state = v_to_state,
      terminal_reason_code = case when p_decision = 'deny' then 'POLICY_DENIED' else null end,
      terminal_at = case when p_decision = 'deny' then clock_timestamp() else null end,
      updated_at = clock_timestamp()
  where run.account_id = p_account_id and run.id = p_workflow_id;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    event_type, actor_type, actor_id, correlation_id, details, payload_hash,
    runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, v_policy_id, v_approval_id,
    'runtime.policy_decided', 'system', p_actor_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object('decision', p_decision, 'ruleset_id', p_ruleset_id),
    v_action_hash, 'runtime-v1', v_run.workflow_version, p_policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', 'recorded',
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'policy_decision_id', v_policy_id,
    'approval_request_id', v_approval_id,
    'state', v_to_state,
    'action_payload_hash', v_action_hash
  );
end
$$;

create function public.runtime_enqueue_outbox_action(
  p_account_id uuid,
  p_workflow_id uuid,
  p_policy_decision_id uuid,
  p_connector_id text,
  p_action_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_actor_id text,
  p_approval_request_id uuid default null,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_policy runtime.policy_decisions%rowtype;
  v_approval public.approval_requests%rowtype;
  v_outbox runtime.outbox_actions%rowtype;
  v_action_hash text;
  v_idempotency_hash text;
  v_status text;
  v_existing boolean := false;
  v_completion_transition_id uuid;
  v_seq bigint;
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'outbox payload must be a JSON object';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox actor';
  end if;
  if p_max_attempts not between 1 and 100 then
    raise exception using errcode = '22023', message = 'invalid outbox max attempts';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  if v_run.current_state <> 'waiting_for_action' then
    raise exception using errcode = '55000', message = 'workflow is not waiting for action';
  end if;

  select decision.* into strict v_policy
  from runtime.policy_decisions as decision
  where decision.account_id = p_account_id
    and decision.workflow_id = p_workflow_id
    and decision.id = p_policy_decision_id;

  if v_policy.decision = 'deny' then
    raise exception using errcode = '55000', message = 'denied action cannot be enqueued';
  end if;

  if v_policy.decision = 'require_approval' then
    if p_approval_request_id is null then
      raise exception using errcode = '55000', message = 'approved request is required';
    end if;
    select request.* into strict v_approval
    from public.approval_requests as request
    where request.account_id = p_account_id
      and request.workflow_id = p_workflow_id
      and request.policy_decision_id = p_policy_decision_id
      and request.id = p_approval_request_id;
    if v_approval.status <> 'approved' or v_approval.outbox_action_id is null then
      raise exception using errcode = '55000', message = 'approval is not linked to an action';
    end if;
    select action.* into strict v_outbox
    from runtime.outbox_actions as action
    where action.account_id = p_account_id and action.id = v_approval.outbox_action_id;
    return pg_catalog.jsonb_build_object(
      'status', 'duplicate', 'outbox_action_id', v_outbox.id,
      'execution_mode', v_outbox.execution_mode, 'outbox_status', v_outbox.status
    );
  end if;

  v_action_hash := runtime.sha256_jsonb(p_payload);
  if v_action_hash <> v_policy.action_payload_hash then
    raise exception using errcode = '22000', message = 'action payload does not match policy decision';
  end if;
  v_idempotency_hash := runtime.sha256_text(p_idempotency_key);
  v_status := case when v_run.execution_mode = 'shadow' then 'simulated' else 'pending' end;

  insert into runtime.outbox_actions (
    account_id, workflow_id, transition_id, policy_decision_id,
    policy_version, connector_id, action_type, execution_mode,
    payload, action_payload_hash, canonicalization_version,
    idempotency_key, idempotency_key_hash, status, max_attempts, completed_at
  ) values (
    p_account_id, p_workflow_id, v_policy.transition_id, p_policy_decision_id,
    v_policy.policy_version, p_connector_id, p_action_type, v_run.execution_mode,
    p_payload, v_action_hash, v_policy.canonicalization_version,
    p_idempotency_key, v_idempotency_hash, v_status, p_max_attempts,
    case when v_status = 'simulated' then clock_timestamp() else null end
  )
  on conflict (account_id, connector_id, idempotency_key_hash) do nothing
  returning * into v_outbox;

  if v_outbox.id is null then
    v_existing := true;
    select action.* into strict v_outbox
    from runtime.outbox_actions as action
    where action.account_id = p_account_id
      and action.connector_id = p_connector_id
      and action.idempotency_key_hash = v_idempotency_hash;
    if v_outbox.workflow_id <> p_workflow_id
      or v_outbox.action_payload_hash <> v_action_hash
      or v_outbox.action_type <> p_action_type then
      raise exception using errcode = '23000', message = 'outbox idempotency collision';
    end if;
  end if;

  if not v_existing then
    insert into runtime.audit_events (
      account_id, workflow_id, transition_id, policy_decision_id, outbox_action_id,
      event_type, actor_type, actor_id, correlation_id, details, payload_hash,
      runtime_contract_version, workflow_version, policy_version
    ) values (
      p_account_id, p_workflow_id, v_policy.transition_id, p_policy_decision_id, v_outbox.id,
      'runtime.outbox_enqueued', 'system', p_actor_id, v_run.correlation_id,
      pg_catalog.jsonb_build_object(
        'connector_id', p_connector_id,
        'action_type', p_action_type,
        'execution_mode', v_run.execution_mode,
        'status', v_status
      ),
      v_action_hash, 'runtime-v1', v_run.workflow_version, v_policy.policy_version
    );
  end if;

  if v_status = 'simulated' and v_run.current_state = 'waiting_for_action' then
    select coalesce(max(t.transition_seq), 0) + 1 into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, lease_epoch, transition_payload, payload_hash
    ) values (
      p_account_id, p_workflow_id, v_seq, 'waiting_for_action', 'completed',
      'action_completed', 'system', p_actor_id, v_run.correlation_id,
      v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
      pg_catalog.jsonb_build_object('outbox_action_id', v_outbox.id, 'simulated', true),
      v_action_hash
    ) returning id into v_completion_transition_id;

    update runtime.workflow_runs
    set current_state = 'completed', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    where account_id = p_account_id and id = p_workflow_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'status', case when v_existing then 'duplicate' else 'created' end,
    'outbox_action_id', v_outbox.id,
    'execution_mode', v_outbox.execution_mode,
    'outbox_status', v_outbox.status,
    'workflow_transition_id', v_completion_transition_id
  );
end
$$;

-- The legacy approval RPC remains responsible for research-review approvals. Runtime approvals
-- must use the atomic resolver below, otherwise an approved row and its required outbox FK could
-- be committed in separate steps (or a rejection could leave the workflow waiting forever).
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
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid decision';
  end if;
  if not exists (
    select 1 from public.users where id = p_user_id and account_id = p_account_id
  ) then
    raise exception 'invalid owner context';
  end if;

  select * into request_row
  from public.approval_requests
  where id = p_request_id and account_id = p_account_id
    and status = 'pending' and expires_at > pg_catalog.now()
  for update;
  if not found then return false; end if;

  if request_row.workflow_id is not null then
    raise exception using
      errcode = '55000',
      message = 'runtime approval requires the atomic runtime resolver';
  end if;

  update public.approval_requests
  set status = p_decision, decided_by = p_user_id, decided_at = pg_catalog.now()
  where id = request_row.id;

  if request_row.source = 'workflow'
    and request_row.action_type = 'research_quality_review'
    and request_row.related_research_run_id is not null then
    update public.research_runs
    set human_review_status = p_decision,
        human_reviewed_by = p_user_id,
        human_reviewed_at = pg_catalog.now(),
        status = case when p_decision = 'approved' then 'done' else 'review_rejected' end
    where id = request_row.related_research_run_id
      and account_id = p_account_id
      and human_review_status = 'pending';
    if not found then raise exception 'research review is no longer pending'; end if;
  end if;

  return true;
end
$$;

create function public.runtime_resolve_approval_and_enqueue_action(
  p_account_id uuid,
  p_workflow_id uuid,
  p_approval_request_id uuid,
  p_user_id uuid,
  p_decision text,
  p_connector_id text,
  p_action_type text,
  p_payload jsonb,
  p_idempotency_key text,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run runtime.workflow_runs%rowtype;
  v_request public.approval_requests%rowtype;
  v_policy runtime.policy_decisions%rowtype;
  v_outbox runtime.outbox_actions%rowtype;
  v_transition_id uuid;
  v_completion_transition_id uuid;
  v_seq bigint;
  v_action_hash text;
  v_idempotency_hash text;
  v_status text;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception using errcode = '22023', message = 'invalid approval decision';
  end if;
  if not exists (
    select 1 from public.users as app_user
    where app_user.id = p_user_id and app_user.account_id = p_account_id
  ) then
    raise exception using errcode = '42501', message = 'invalid approval owner context';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = p_workflow_id
  for update;

  select request.* into strict v_request
  from public.approval_requests as request
  where request.account_id = p_account_id
    and request.workflow_id = p_workflow_id
    and request.id = p_approval_request_id
  for update;

  if v_run.current_state <> 'waiting_for_approval'
    or v_request.status <> 'pending'
    or v_request.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'approval request is not pending';
  end if;

  select decision.* into strict v_policy
  from runtime.policy_decisions as decision
  where decision.account_id = p_account_id
    and decision.workflow_id = p_workflow_id
    and decision.id = v_request.policy_decision_id;

  select coalesce(max(t.transition_seq), 0) + 1 into v_seq
  from runtime.workflow_transitions as t
  where t.account_id = p_account_id and t.workflow_id = p_workflow_id;

  if p_decision = 'rejected' then
    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, lease_epoch
    ) values (
      p_account_id, p_workflow_id, v_seq, 'waiting_for_approval', 'denied',
      'approval_resolved', 'user', p_user_id::text, v_run.correlation_id,
      v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch
    ) returning id into v_transition_id;

    update public.approval_requests
    set status = 'rejected', decided_by = p_user_id, decided_at = clock_timestamp()
    where account_id = p_account_id and id = p_approval_request_id;

    update runtime.workflow_runs
    set current_state = 'denied', terminal_reason_code = 'APPROVAL_REJECTED',
        terminal_at = clock_timestamp(), updated_at = clock_timestamp()
    where account_id = p_account_id and id = p_workflow_id;
  else
    if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
      raise exception using errcode = '22023', message = 'approved action payload must be an object';
    end if;
    if p_max_attempts not between 1 and 100 then
      raise exception using errcode = '22023', message = 'invalid outbox max attempts';
    end if;

    v_action_hash := runtime.sha256_jsonb(p_payload);
    if v_action_hash <> v_policy.action_payload_hash
      or v_action_hash <> v_request.action_payload_hash then
      raise exception using errcode = '22000', message = 'approved payload does not match policy decision';
    end if;

    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, lease_epoch, transition_payload, payload_hash
    ) values (
      p_account_id, p_workflow_id, v_seq, 'waiting_for_approval', 'waiting_for_action',
      'approval_resolved', 'user', p_user_id::text, v_run.correlation_id,
      v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
      pg_catalog.jsonb_build_object('approval_request_id', p_approval_request_id),
      v_action_hash
    ) returning id into v_transition_id;

    update runtime.workflow_runs
    set current_state = 'waiting_for_action', updated_at = clock_timestamp()
    where account_id = p_account_id and id = p_workflow_id;

    v_idempotency_hash := runtime.sha256_text(p_idempotency_key);
    v_status := case when v_run.execution_mode = 'shadow' then 'simulated' else 'pending' end;

    insert into runtime.outbox_actions (
      account_id, workflow_id, transition_id, policy_decision_id,
      policy_version, connector_id, action_type, execution_mode,
      payload, action_payload_hash, canonicalization_version,
      idempotency_key, idempotency_key_hash, status, max_attempts, completed_at
    ) values (
      p_account_id, p_workflow_id, v_transition_id, v_policy.id,
      v_policy.policy_version, p_connector_id, p_action_type, v_run.execution_mode,
      p_payload, v_action_hash, v_policy.canonicalization_version,
      p_idempotency_key, v_idempotency_hash, v_status, p_max_attempts,
      case when v_status = 'simulated' then clock_timestamp() else null end
    ) returning * into v_outbox;

    update public.approval_requests
    set status = 'approved', decided_by = p_user_id, decided_at = clock_timestamp(),
        outbox_action_id = v_outbox.id
    where account_id = p_account_id and id = p_approval_request_id;

    update runtime.outbox_actions
    set approval_request_id = p_approval_request_id, updated_at = clock_timestamp()
    where account_id = p_account_id and id = v_outbox.id;

    if v_status = 'simulated' then
      v_seq := v_seq + 1;
      insert into runtime.workflow_transitions (
        account_id, workflow_id, transition_seq, from_state, to_state,
        transition_type, actor_type, actor_id, correlation_id,
        workflow_version, policy_version, lease_epoch, transition_payload, payload_hash
      ) values (
        p_account_id, p_workflow_id, v_seq, 'waiting_for_action', 'completed',
        'action_completed', 'system', 'shadow-simulator', v_run.correlation_id,
        v_run.workflow_version, v_policy.policy_version, v_run.lease_epoch,
        pg_catalog.jsonb_build_object('outbox_action_id', v_outbox.id, 'simulated', true),
        v_action_hash
      ) returning id into v_completion_transition_id;

      update runtime.workflow_runs
      set current_state = 'completed', terminal_at = clock_timestamp(), updated_at = clock_timestamp()
      where account_id = p_account_id and id = p_workflow_id;
    end if;
  end if;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    outbox_action_id, event_type, actor_type, actor_id, correlation_id,
    details, payload_hash, runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, p_workflow_id, v_transition_id, v_policy.id, p_approval_request_id,
    v_outbox.id, 'runtime.approval_resolved', 'user', p_user_id::text, v_run.correlation_id,
    pg_catalog.jsonb_build_object('decision', p_decision, 'outbox_status', v_status),
    v_action_hash, 'runtime-v1', v_run.workflow_version, v_policy.policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', p_decision,
    'workflow_id', p_workflow_id,
    'transition_id', v_transition_id,
    'outbox_action_id', v_outbox.id,
    'outbox_status', v_status,
    'completion_transition_id', v_completion_transition_id
  );
end
$$;

create function public.runtime_claim_outbox_actions(
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

create function public.runtime_finish_outbox_action(
  p_account_id uuid,
  p_outbox_action_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_result_status text,
  p_worker_id text,
  p_next_attempt_at timestamptz default null,
  p_provider_result_ref text default null,
  p_error_code text default null,
  p_sanitized_error_message text default null,
  p_error_evidence_ref text default null,
  p_reconciliation_state text default 'not_required'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action runtime.outbox_actions%rowtype;
  v_run runtime.workflow_runs%rowtype;
  v_to_state text;
  v_transition_type text;
  v_transition_id uuid;
  v_seq bigint;
begin
  if p_result_status not in ('completed', 'retry_scheduled', 'failed', 'dead_letter', 'cancelled') then
    raise exception using errcode = '22023', message = 'invalid outbox result status';
  end if;
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_result_status = 'retry_scheduled' and p_next_attempt_at is null then
    raise exception using errcode = '22023', message = 'outbox retry requires next attempt time';
  end if;
  if p_result_status <> 'retry_scheduled' and p_next_attempt_at is not null then
    raise exception using errcode = '22023', message = 'unexpected outbox next attempt time';
  end if;
  if p_result_status in ('failed', 'dead_letter') and p_error_code is null then
    raise exception using errcode = '22023', message = 'outbox failure requires error code';
  end if;

  select action.* into strict v_action
  from runtime.outbox_actions as action
  where action.account_id = p_account_id and action.id = p_outbox_action_id
  for update;

  if v_action.status <> 'processing'
    or v_action.lease_epoch <> p_expected_epoch
    or v_action.claim_token is distinct from p_claim_token
    or v_action.lease_until <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'stale or invalid outbox lease';
  end if;

  select run.* into strict v_run
  from runtime.workflow_runs as run
  where run.account_id = p_account_id and run.id = v_action.workflow_id
  for update;

  update runtime.outbox_actions as action
  set status = p_result_status,
      next_attempt_at = case when p_result_status = 'retry_scheduled' then p_next_attempt_at else null end,
      claimed_at = case when p_result_status = 'retry_scheduled' then action.claimed_at else action.claimed_at end,
      lease_until = null,
      claim_token = null,
      completed_at = case when p_result_status in ('completed', 'failed', 'dead_letter', 'cancelled')
        then clock_timestamp() else null end,
      provider_result_ref = p_provider_result_ref,
      reconciliation_state = p_reconciliation_state,
      last_error_code = p_error_code,
      sanitized_error_message = p_sanitized_error_message,
      error_evidence_ref = p_error_evidence_ref,
      updated_at = clock_timestamp()
  where action.account_id = p_account_id and action.id = p_outbox_action_id;

  if p_result_status <> 'retry_scheduled' then
    if v_run.current_state <> 'waiting_for_action' then
      raise exception using errcode = '55000', message = 'workflow is not waiting for outbox action';
    end if;

    v_to_state := case p_result_status
      when 'completed' then 'completed'
      when 'failed' then 'failed'
      when 'dead_letter' then 'dead_letter'
      else 'cancelled'
    end;
    v_transition_type := case p_result_status
      when 'completed' then 'action_completed'
      when 'failed' then 'failed'
      when 'dead_letter' then 'dead_letter'
      else 'cancelled'
    end;

    select coalesce(max(t.transition_seq), 0) + 1 into v_seq
    from runtime.workflow_transitions as t
    where t.account_id = p_account_id and t.workflow_id = v_action.workflow_id;

    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, policy_version, claim_token, lease_epoch,
      transition_payload, payload_hash, evidence_ref
    ) values (
      p_account_id, v_action.workflow_id, v_seq, 'waiting_for_action', v_to_state,
      v_transition_type, 'worker', p_worker_id, v_run.correlation_id,
      v_run.workflow_version, v_action.policy_version, p_claim_token, p_expected_epoch,
      pg_catalog.jsonb_build_object(
        'outbox_action_id', p_outbox_action_id,
        'result_status', p_result_status,
        'provider_result_ref', p_provider_result_ref
      ),
      v_action.action_payload_hash, p_error_evidence_ref
    ) returning id into v_transition_id;

    update runtime.workflow_runs
    set current_state = v_to_state,
        terminal_reason_code = case when v_to_state = 'completed' then null
          else coalesce(p_error_code, 'OUTBOX_' || upper(p_result_status)) end,
        terminal_at = clock_timestamp(), updated_at = clock_timestamp(),
        last_error_code = p_error_code,
        sanitized_error_message = p_sanitized_error_message,
        error_evidence_ref = p_error_evidence_ref
    where account_id = p_account_id and id = v_action.workflow_id;
  end if;

  insert into runtime.audit_events (
    account_id, workflow_id, transition_id, policy_decision_id, approval_request_id,
    outbox_action_id, event_type, actor_type, actor_id, correlation_id,
    details, payload_hash, runtime_contract_version, workflow_version, policy_version
  ) values (
    p_account_id, v_action.workflow_id, v_transition_id, v_action.policy_decision_id,
    v_action.approval_request_id, p_outbox_action_id, 'runtime.outbox_finished',
    'worker', p_worker_id, v_run.correlation_id,
    pg_catalog.jsonb_build_object(
      'result_status', p_result_status,
      'reconciliation_state', p_reconciliation_state
    ),
    v_action.action_payload_hash, 'runtime-v1', v_run.workflow_version, v_action.policy_version
  );

  return pg_catalog.jsonb_build_object(
    'status', p_result_status,
    'outbox_action_id', p_outbox_action_id,
    'workflow_id', v_action.workflow_id,
    'workflow_transition_id', v_transition_id
  );
end
$$;

revoke all on function public.runtime_ingest_event(
  uuid, text, text, jsonb, text, uuid, text, timestamptz, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.runtime_claim_workflow(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.runtime_transition_workflow(
  uuid, uuid, bigint, uuid, text, jsonb, text, text, timestamptz, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.runtime_record_policy_decision(
  uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, integer
) from public, anon, authenticated;
revoke all on function public.runtime_enqueue_outbox_action(
  uuid, uuid, uuid, text, text, jsonb, text, text, uuid, integer
) from public, anon, authenticated;
revoke all on function public.runtime_resolve_approval_and_enqueue_action(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, text, integer
) from public, anon, authenticated;
revoke all on function public.runtime_claim_outbox_actions(text, integer, integer, text)
  from public, anon, authenticated;
revoke all on function public.runtime_finish_outbox_action(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.runtime_ingest_event(
  uuid, text, text, jsonb, text, uuid, text, timestamptz, text, text, text, text, text
) to service_role;
grant execute on function public.runtime_claim_workflow(text, integer, integer, text)
  to service_role;
grant execute on function public.runtime_transition_workflow(
  uuid, uuid, bigint, uuid, text, jsonb, text, text, timestamptz, text, text, text, text
) to service_role;
grant execute on function public.runtime_record_policy_decision(
  uuid, uuid, text, text, text, jsonb, jsonb, jsonb, text, text, text, text, integer
) to service_role;
grant execute on function public.runtime_enqueue_outbox_action(
  uuid, uuid, uuid, text, text, jsonb, text, text, uuid, integer
) to service_role;
grant execute on function public.runtime_resolve_approval_and_enqueue_action(
  uuid, uuid, uuid, uuid, text, text, text, jsonb, text, integer
) to service_role;
grant execute on function public.runtime_claim_outbox_actions(text, integer, integer, text)
  to service_role;
grant execute on function public.runtime_finish_outbox_action(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text, text, text, text
) to service_role;

comment on function public.runtime_ingest_event(
  uuid, text, text, jsonb, text, uuid, text, timestamptz, text, text, text, text, text
) is 'Idempotently ingests a normalized event and creates one queued workflow.';
comment on function public.runtime_claim_workflow(text, integer, integer, text)
  is 'Claims due workflows with SKIP LOCKED and returns fencing tokens.';
comment on function public.runtime_transition_workflow(
  uuid, uuid, bigint, uuid, text, jsonb, text, text, timestamptz, text, text, text, text
) is 'Applies one lease-fenced worker transition and writes immutable audit evidence.';
comment on function public.runtime_claim_outbox_actions(text, integer, integer, text)
  is 'Claims live outbox actions with SKIP LOCKED, circuit-breaker filtering and fencing tokens.';
