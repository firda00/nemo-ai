begin;

select plan(1);

insert into public.accounts (id, name)
values ('61000000-0000-4000-8000-000000000001', 'runtime-live-gate-test');

do $$
declare
  v_ingest jsonb;
  v_claim record;
  v_eval jsonb;
  v_gate jsonb;
  v_low_ingest jsonb;
  v_low_claim record;
  v_low_gate jsonb;
  v_shadow_ingest jsonb;
  v_shadow_claim record;
  v_rejected boolean := false;
begin
  v_eval := public.runtime_record_vision_eval_summary(
    '61000000-0000-4000-8000-000000000001',
    'vision_live_test', 0.99, 0.98, 0.005, 200, repeat('a', 64), 0.99
  );
  if (v_eval ->> 'passed')::boolean is not true then
    raise exception 'valid precision evaluation did not pass';
  end if;

  v_ingest := public.runtime_ingest_event(
    '61000000-0000-4000-8000-000000000001',
    'vision', 'live-gate-high', '{}'::jsonb,
    'live', '61100000-0000-4000-8000-000000000001',
    p_event_type => 'vision.bay_vehicle_entered', p_workflow_type => 'vision_live_test'
  );
  select * into strict v_claim from public.runtime_claim_workflow(
    'live-gate-worker', 30, 1, 'live', 'vision_live_test'
  );
  perform public.runtime_checkpoint_and_transition(
    v_claim.account_id, v_claim.workflow_id, v_claim.lease_epoch, v_claim.claim_token,
    '{"proposed_action":{"connector_id":"gate","action":"open"},"approval_summary":"Open gate"}'::jsonb,
    'live-gate-test'
  );
  v_gate := public.runtime_evaluate_live_gate(
    v_claim.account_id, v_claim.workflow_id, 0.99, 0.95
  );
  if v_gate ->> 'state' <> 'waiting_for_action'
    or v_gate ->> 'outbox_eligibility' <> 'queued'
    or v_gate ->> 'approval_request_id' is not null then
    raise exception 'passing live gate did not open canonical outbox path';
  end if;

  v_low_ingest := public.runtime_ingest_event(
    '61000000-0000-4000-8000-000000000001',
    'vision', 'live-gate-low', '{}'::jsonb,
    'live', '61200000-0000-4000-8000-000000000001',
    p_event_type => 'vision.bay_vehicle_entered', p_workflow_type => 'vision_live_test'
  );
  select * into strict v_low_claim from public.runtime_claim_workflow(
    'live-gate-worker', 30, 1, 'live', 'vision_live_test'
  );
  perform public.runtime_checkpoint_and_transition(
    v_low_claim.account_id, v_low_claim.workflow_id, v_low_claim.lease_epoch, v_low_claim.claim_token,
    '{"proposed_action":{"connector_id":"gate","action":"open"}}'::jsonb,
    'live-gate-test'
  );
  v_low_gate := public.runtime_evaluate_live_gate(
    v_low_claim.account_id, v_low_claim.workflow_id, 0.80, 0.95
  );
  if v_low_gate ->> 'state' <> 'waiting_for_approval'
    or v_low_gate ->> 'approval_request_id' is null then
    raise exception 'low confidence did not enter human approval';
  end if;

  v_shadow_ingest := public.runtime_ingest_event(
    '61000000-0000-4000-8000-000000000001',
    'vision', 'shadow-cannot-live', '{}'::jsonb,
    'shadow', '61300000-0000-4000-8000-000000000001',
    p_event_type => 'vision.bay_vehicle_entered', p_workflow_type => 'vision_shadow_test'
  );
  select * into strict v_shadow_claim from public.runtime_claim_workflow(
    'shadow-gate-worker', 30, 1, 'shadow', 'vision_shadow_test'
  );
  perform public.runtime_checkpoint_and_transition(
    v_shadow_claim.account_id, v_shadow_claim.workflow_id,
    v_shadow_claim.lease_epoch, v_shadow_claim.claim_token,
    '{"proposed_action":{"connector_id":"gate","action":"open"}}'::jsonb,
    'live-gate-test'
  );
  begin
    perform public.runtime_evaluate_live_gate(
      v_shadow_claim.account_id, v_shadow_claim.workflow_id, 1, 0.95
    );
  exception when sqlstate '55000' then
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'shadow workflow entered live gate'; end if;
end
$$;

do $$
begin
  if pg_catalog.has_function_privilege(
    'authenticated', 'public.runtime_evaluate_live_gate(uuid,uuid,numeric,numeric)', 'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'anon', 'public.runtime_record_vision_eval_summary(uuid,text,numeric,numeric,numeric,integer,text,numeric)',
    'EXECUTE'
  ) then
    raise exception 'application roles can access live gate RPCs';
  end if;
end
$$;

select pass('runtime live gate preserves policy, approval, eval and shadow isolation invariants');
select * from finish();

rollback;
