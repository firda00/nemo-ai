begin;

select plan(1);

insert into public.accounts (id, name) values
  ('71000000-0000-4000-8000-000000000001', 'dashboard-test-a'),
  ('72000000-0000-4000-8000-000000000002', 'dashboard-test-b');
insert into auth.users (id) values
  ('71100000-0000-4000-8000-000000000001'),
  ('72100000-0000-4000-8000-000000000002');
update public.users set account_id = '71000000-0000-4000-8000-000000000001', role = 'operator'
where id = '71100000-0000-4000-8000-000000000001';
update public.users set account_id = '72000000-0000-4000-8000-000000000002', role = 'operator'
where id = '72100000-0000-4000-8000-000000000002';

do $$
declare
  v_claim record;
  v_gate jsonb;
  v_result jsonb;
  v_approval_id uuid;
  v_cross_tenant_rejected boolean := false;
begin
  perform public.runtime_ingest_event(
    '71000000-0000-4000-8000-000000000001', 'vision', 'dashboard-approve', '{}'::jsonb,
    'live', '71200000-0000-4000-8000-000000000001', p_workflow_type => 'dashboard_test'
  );
  select * into strict v_claim
  from public.runtime_claim_workflow('dashboard-test-worker', 30, 1, 'live', 'dashboard_test');
  perform public.runtime_checkpoint_and_transition(
    v_claim.account_id, v_claim.workflow_id, v_claim.lease_epoch, v_claim.claim_token,
    '{"proposed_action":{"connector_id":"amocrm","action":"send_offer"}}'::jsonb,
    'dashboard-test'
  );
  v_gate := public.runtime_evaluate_live_gate(v_claim.account_id, v_claim.workflow_id, 0.5, 0.95);
  v_approval_id := (v_gate ->> 'approval_request_id')::uuid;

  if pg_catalog.jsonb_array_length(
    public.runtime_dashboard_list_approvals(v_claim.account_id, 50)
  ) is distinct from 1 then
    raise exception 'dashboard approval list is not tenant-scoped/pending';
  end if;

  begin
    perform public.runtime_dashboard_decide_approval(
      '72000000-0000-4000-8000-000000000002', v_approval_id,
      '72100000-0000-4000-8000-000000000002', 'approve', null
    );
  exception when no_data_found then
    v_cross_tenant_rejected := true;
  end;
  if v_cross_tenant_rejected is distinct from true then
    raise exception 'cross-tenant dashboard approval was accepted';
  end if;

  v_result := public.runtime_dashboard_decide_approval(
    v_claim.account_id, v_approval_id, '71100000-0000-4000-8000-000000000001',
    'approve', null
  );
  if v_result ->> 'state' is distinct from 'waiting_for_action' then
    raise exception 'dashboard approve did not enter waiting_for_action: %', v_result;
  end if;
  if not exists (
    select 1 from runtime.outbox_actions as action
    where action.account_id = v_claim.account_id
      and action.workflow_id = v_claim.workflow_id
      and action.status = 'pending'
  ) then
    raise exception 'dashboard approve did not enqueue a live outbox action';
  end if;
  if (public.runtime_dashboard_metrics(v_claim.account_id) ->> 'zero_data_loss')::boolean
    is distinct from true then
    raise exception 'dashboard metrics reported an orphaned inbox event';
  end if;
  if pg_catalog.jsonb_array_length(
    public.runtime_dashboard_workflow_trace(v_claim.account_id, v_claim.workflow_id) -> 'transitions'
  ) < 3 then
    raise exception 'dashboard trace omitted runtime transitions';
  end if;

  perform public.runtime_ingest_event(
    '71000000-0000-4000-8000-000000000001', 'vision', 'dashboard-reject', '{}'::jsonb,
    'live', '71300000-0000-4000-8000-000000000001', p_workflow_type => 'dashboard_test'
  );
  select * into strict v_claim
  from public.runtime_claim_workflow('dashboard-test-worker', 30, 1, 'live', 'dashboard_test');
  perform public.runtime_checkpoint_and_transition(
    v_claim.account_id, v_claim.workflow_id, v_claim.lease_epoch, v_claim.claim_token,
    '{"proposed_action":{"connector_id":"amocrm","action":"send_offer"}}'::jsonb,
    'dashboard-test'
  );
  v_gate := public.runtime_evaluate_live_gate(v_claim.account_id, v_claim.workflow_id, 0.5, 0.95);
  v_result := public.runtime_dashboard_decide_approval(
    v_claim.account_id, (v_gate ->> 'approval_request_id')::uuid,
    '71100000-0000-4000-8000-000000000001', 'reject', 'operator rejected'
  );
  if v_result ->> 'state' is distinct from 'cancelled' then
    raise exception 'dashboard reject did not enter cancelled: %', v_result;
  end if;
end
$$;

do $$
begin
  if pg_catalog.has_function_privilege(
    'authenticated', 'public.runtime_dashboard_metrics(uuid)', 'EXECUTE'
  ) or pg_catalog.has_function_privilege(
    'anon', 'public.runtime_dashboard_decide_approval(uuid,uuid,uuid,text,text)', 'EXECUTE'
  ) then
    raise exception 'dashboard runtime RPCs are exposed to application roles';
  end if;
end
$$;

select pass('dashboard telemetry, HITL FSM, outbox and tenant isolation invariants hold');
select * from finish();

rollback;
