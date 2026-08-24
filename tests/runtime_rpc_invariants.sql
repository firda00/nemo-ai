-- Contract checks for ADR 001 Durable Operations Runtime Phase 2 RPCs.
-- Run against an isolated local database. All fixtures are rolled back.

begin;

insert into public.accounts (id, name) values
  ('31000000-0000-4000-8000-000000000001', 'runtime-rpc-test-a'),
  ('32000000-0000-4000-8000-000000000002', 'runtime-rpc-test-b'),
  ('33000000-0000-4000-8000-000000000003', 'runtime-rpc-test-c');

insert into auth.users (id) values ('33100000-0000-4000-8000-000000000003');
update public.users
set account_id = '33000000-0000-4000-8000-000000000003',
    email = 'runtime-approval@example.invalid',
    role = 'owner'
where id = '33100000-0000-4000-8000-000000000003';

do $$
declare
  v_created jsonb;
  v_duplicate jsonb;
  v_policy jsonb;
  v_outbox jsonb;
  v_finished jsonb;
  v_claim record;
  v_outbox_claim record;
  v_workflow_id uuid;
  v_policy_id uuid;
  v_outbox_id uuid;
  v_approval_id uuid;
  v_old_claim_token uuid;
  v_old_lease_epoch bigint;
  v_count bigint;
  v_rejected boolean;
begin
  -- Shadow: ingest is idempotent and produces exactly one queued workflow.
  v_created := public.runtime_ingest_event(
    '31000000-0000-4000-8000-000000000001',
    'amocrm', 'shadow-event-1', '{"lead_id":"shadow-1"}'::jsonb,
    'shadow', '31100000-0000-4000-8000-000000000001',
    p_event_type => 'lead.created', p_workflow_type => 'amocrm_shadow'
  );
  v_duplicate := public.runtime_ingest_event(
    '31000000-0000-4000-8000-000000000001',
    'amocrm', 'shadow-event-1', '{"lead_id":"shadow-1"}'::jsonb,
    'shadow', '31100000-0000-4000-8000-000000000001',
    p_event_type => 'lead.created', p_workflow_type => 'amocrm_shadow'
  );

  if v_created->>'status' <> 'created' or v_duplicate->>'status' <> 'duplicate'
    or v_created->>'workflow_id' <> v_duplicate->>'workflow_id' then
    raise exception 'TEST_FAILURE [idempotent ingest]: % / %', v_created, v_duplicate;
  end if;
  raise notice 'PASS [idempotent ingest]';

  v_workflow_id := (v_created->>'workflow_id')::uuid;
  select * into strict v_claim
  from public.runtime_claim_workflow('shadow-worker', 300, 1, 'shadow');
  if v_claim.workflow_id <> v_workflow_id or v_claim.lease_epoch <> 1 then
    raise exception 'TEST_FAILURE [workflow claim fencing]';
  end if;
  raise notice 'PASS [workflow claim fencing]';

  v_old_claim_token := v_claim.claim_token;
  v_old_lease_epoch := v_claim.lease_epoch;
  update runtime.workflow_runs
  set lease_until = clock_timestamp() - interval '1 second'
  where account_id = '31000000-0000-4000-8000-000000000001' and id = v_workflow_id;
  select * into strict v_claim
  from public.runtime_claim_workflow('shadow-worker-recovery', 300, 1, 'shadow');
  if v_claim.workflow_id <> v_workflow_id or v_claim.lease_epoch <> 2
    or v_claim.claim_token = v_old_claim_token then
    raise exception 'TEST_FAILURE [expired workflow lease recovery]';
  end if;
  raise notice 'PASS [expired workflow lease recovered with a new fence]';

  v_rejected := false;
  begin
    perform public.runtime_transition_workflow(
      '31000000-0000-4000-8000-000000000001', v_workflow_id,
      v_old_lease_epoch, v_old_claim_token, 'waiting_for_policy', '{}'::jsonb,
      'stale-worker', 'policy_requested'
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [stale workflow token]'; end if;
  raise notice 'PASS [stale workflow token rejected]';

  perform public.runtime_transition_workflow(
    '31000000-0000-4000-8000-000000000001', v_workflow_id,
    v_claim.lease_epoch, v_claim.claim_token, 'waiting_for_policy', '{}'::jsonb,
    'shadow-worker', 'policy_requested'
  );

  v_policy := public.runtime_record_policy_decision(
    '31000000-0000-4000-8000-000000000001', v_workflow_id,
    'amocrm-shadow-policy', '1.0.0', 'allow', '[]'::jsonb,
    '{"risk":"low"}'::jsonb, '{"task":"create"}'::jsonb, 'policy-engine'
  );
  v_policy_id := (v_policy->>'policy_decision_id')::uuid;
  v_outbox := public.runtime_enqueue_outbox_action(
    '31000000-0000-4000-8000-000000000001', v_workflow_id, v_policy_id,
    'amocrm', 'task.create', '{"task":"create"}'::jsonb,
    'shadow-action-1', 'shadow-enqueuer'
  );
  if v_outbox->>'outbox_status' <> 'simulated' then
    raise exception 'TEST_FAILURE [shadow outbox invariant]: %', v_outbox;
  end if;
  if not exists (
    select 1 from runtime.workflow_runs
    where account_id = '31000000-0000-4000-8000-000000000001'
      and id = v_workflow_id and current_state = 'completed'
  ) then
    raise exception 'TEST_FAILURE [shadow workflow completion]';
  end if;
  raise notice 'PASS [shadow simulation completes without live claim]';

  -- Live: policy-bound outbox action is leased and finished with its own fencing token.
  v_created := public.runtime_ingest_event(
    '32000000-0000-4000-8000-000000000002',
    'amocrm', 'live-event-1', '{"lead_id":"live-1"}'::jsonb,
    'live', '32100000-0000-4000-8000-000000000002',
    p_event_type => 'lead.created', p_workflow_type => 'amocrm_live'
  );
  v_workflow_id := (v_created->>'workflow_id')::uuid;
  select * into strict v_claim
  from public.runtime_claim_workflow('live-worker', 300, 1, 'live');
  perform public.runtime_transition_workflow(
    '32000000-0000-4000-8000-000000000002', v_workflow_id,
    v_claim.lease_epoch, v_claim.claim_token, 'waiting_for_policy', '{}'::jsonb,
    'live-worker', 'policy_requested'
  );
  v_policy := public.runtime_record_policy_decision(
    '32000000-0000-4000-8000-000000000002', v_workflow_id,
    'amocrm-live-policy', '1.0.0', 'allow', '[]'::jsonb,
    '{"risk":"low"}'::jsonb, '{"task":"create-live"}'::jsonb, 'policy-engine'
  );
  v_policy_id := (v_policy->>'policy_decision_id')::uuid;
  v_outbox := public.runtime_enqueue_outbox_action(
    '32000000-0000-4000-8000-000000000002', v_workflow_id, v_policy_id,
    'amocrm', 'task.create', '{"task":"create-live"}'::jsonb,
    'live-action-1', 'live-enqueuer'
  );
  v_outbox_id := (v_outbox->>'outbox_action_id')::uuid;
  if v_outbox->>'outbox_status' <> 'pending' then
    raise exception 'TEST_FAILURE [live outbox pending]: %', v_outbox;
  end if;

  select * into strict v_outbox_claim
  from public.runtime_claim_outbox_actions('connector-worker', 300, 1, 'amocrm');
  if v_outbox_claim.outbox_action_id <> v_outbox_id or v_outbox_claim.lease_epoch <> 1 then
    raise exception 'TEST_FAILURE [outbox claim fencing]';
  end if;
  raise notice 'PASS [live outbox claim fencing]';

  v_rejected := false;
  begin
    perform public.runtime_finish_outbox_action(
      '32000000-0000-4000-8000-000000000002', v_outbox_id,
      v_outbox_claim.lease_epoch, gen_random_uuid(), 'completed', 'connector-worker'
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [stale outbox token]'; end if;
  raise notice 'PASS [stale outbox token rejected]';

  v_finished := public.runtime_finish_outbox_action(
    '32000000-0000-4000-8000-000000000002', v_outbox_id,
    v_outbox_claim.lease_epoch, v_outbox_claim.claim_token,
    'completed', 'connector-worker', p_provider_result_ref => 'evidence://provider/result-1'
  );
  if v_finished->>'status' <> 'completed' then
    raise exception 'TEST_FAILURE [outbox completion]: %', v_finished;
  end if;
  if not exists (
    select 1 from runtime.workflow_runs
    where account_id = '32000000-0000-4000-8000-000000000002'
      and id = v_workflow_id and current_state = 'completed'
  ) then
    raise exception 'TEST_FAILURE [live workflow completion]';
  end if;
  raise notice 'PASS [live outbox completion]';

  -- Approval: decision, workflow transition and outbox link commit atomically.
  v_created := public.runtime_ingest_event(
    '33000000-0000-4000-8000-000000000003',
    'amocrm', 'approval-event-1', '{"lead_id":"approval-1"}'::jsonb,
    'shadow', '33200000-0000-4000-8000-000000000003',
    p_event_type => 'lead.created', p_workflow_type => 'amocrm_approval'
  );
  v_workflow_id := (v_created->>'workflow_id')::uuid;
  select * into strict v_claim
  from public.runtime_claim_workflow('approval-worker', 300, 1, 'shadow');
  perform public.runtime_transition_workflow(
    '33000000-0000-4000-8000-000000000003', v_workflow_id,
    v_claim.lease_epoch, v_claim.claim_token, 'waiting_for_policy', '{}'::jsonb,
    'approval-worker', 'policy_requested'
  );
  v_policy := public.runtime_record_policy_decision(
    '33000000-0000-4000-8000-000000000003', v_workflow_id,
    'amocrm-approval-policy', '1.0.0', 'require_approval',
    '["external_write"]'::jsonb, '{"risk":"medium"}'::jsonb,
    '{"task":"approved-shadow"}'::jsonb, 'policy-engine',
    p_approval_summary => 'Approve shadow task'
  );
  v_approval_id := (v_policy->>'approval_request_id')::uuid;
  v_rejected := false;
  begin
    perform public.decide_approval_request(
      '33000000-0000-4000-8000-000000000003',
      '33100000-0000-4000-8000-000000000003',
      v_approval_id, 'approved'
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [legacy approval bypass]'; end if;
  raise notice 'PASS [legacy approval RPC cannot bypass runtime lifecycle]';

  v_outbox := public.runtime_resolve_approval_and_enqueue_action(
    '33000000-0000-4000-8000-000000000003', v_workflow_id, v_approval_id,
    '33100000-0000-4000-8000-000000000003', 'approved',
    'amocrm', 'task.create', '{"task":"approved-shadow"}'::jsonb,
    'approval-action-1'
  );
  if v_outbox->>'outbox_status' <> 'simulated'
    or not exists (
      select 1 from public.approval_requests
      where account_id = '33000000-0000-4000-8000-000000000003'
        and id = v_approval_id and status = 'approved' and outbox_action_id is not null
    ) then
    raise exception 'TEST_FAILURE [approval outbox lifecycle]: %', v_outbox;
  end if;
  raise notice 'PASS [approval and outbox lifecycle is atomic]';

  -- Kill switch must fail closed before any new inbox row is accepted.
  update runtime.system_controls
  set kill_switch_active = true, claims_paused = true, ingestion_paused = true,
      reason_code = 'TEST_KILL_SWITCH', activated_by = 'runtime-test',
      activated_at = clock_timestamp(), control_epoch = control_epoch + 1,
      updated_at = clock_timestamp()
  where singleton;
  v_rejected := false;
  begin
    perform public.runtime_ingest_event(
      '31000000-0000-4000-8000-000000000001',
      'amocrm', 'blocked-event', '{}'::jsonb, 'shadow',
      '31300000-0000-4000-8000-000000000001'
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [kill switch ingestion]'; end if;
  if exists (
    select 1 from runtime.inbox_events
    where account_id = '31000000-0000-4000-8000-000000000001'
      and external_event_id = 'blocked-event'
  ) then
    raise exception 'TEST_FAILURE [kill switch wrote inbox row]';
  end if;
  raise notice 'PASS [kill switch fails closed]';

  select count(*) into v_count
  from runtime.audit_events
  where account_id in (
    '31000000-0000-4000-8000-000000000001',
    '32000000-0000-4000-8000-000000000002',
    '33000000-0000-4000-8000-000000000003'
  );
  if v_count < 10 then raise exception 'TEST_FAILURE [audit coverage]: %', v_count; end if;
  raise notice 'PASS [audit coverage: % events]', v_count;

  if has_function_privilege('anon',
      'public.runtime_claim_workflow(text,integer,integer,text)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.runtime_claim_workflow(text,integer,integer,text)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.runtime_claim_workflow(text,integer,integer,text)', 'EXECUTE') then
    raise exception 'TEST_FAILURE [RPC grants]';
  end if;
  raise notice 'PASS [service-role-only RPC grants]';
end
$$;

rollback;
