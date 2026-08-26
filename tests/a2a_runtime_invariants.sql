-- Durable A2A behavioral checks. Fixtures are isolated and rolled back.
begin;

select plan(1);

insert into public.accounts (id, name)
values ('41000000-0000-4000-8000-000000000001', 'a2a-runtime-test');

do $$
declare
  v_ingested jsonb;
  v_workflow_id uuid;
  v_claim record;
  v_outbox_claim record;
  v_inbox_claim record;
  v_message jsonb;
  v_created record;
  v_duplicate record;
  v_received record;
  v_rejected boolean;
  v_count integer;
begin
  v_ingested := public.runtime_ingest_event(
    '41000000-0000-4000-8000-000000000001',
    'a2a_test', 'a2a-event-1', '{"test":true}'::jsonb, 'shadow',
    '41100000-0000-4000-8000-000000000001',
    p_event_type => 'a2a.test', p_workflow_type => 'a2a_contract_test'
  );
  v_workflow_id := (v_ingested ->> 'workflow_id')::uuid;
  select * into strict v_claim
  from public.runtime_claim_workflow('a2a-supervisor', 300, 1, 'shadow', 'a2a_contract_test');

  v_message := jsonb_build_object(
    'version', '1.0',
    'message_id', '41200000-0000-7000-8000-000000000001',
    'account_id', '41000000-0000-4000-8000-000000000001',
    'workflow_id', v_workflow_id::text,
    'from_agent_id', 'finance',
    'to_agent_id', 'proposal',
    'intent', 'result',
    'created_at', clock_timestamp(),
    'sender_lease_epoch', v_claim.lease_epoch,
    'summary', 'Verified estimate ready.',
    'data', jsonb_build_object('total_minor', 125000),
    'artifact_refs', '[]'::jsonb,
    'evidence_refs', jsonb_build_array(jsonb_build_object(
      'evidence_id', 'price-list-v4', 'source_type', 'tenant_record'
    )),
    'confidence', 0.98,
    'requires_approval', false
  );

  select * into strict v_created from public.runtime_enqueue_a2a_message(
    '41000000-0000-4000-8000-000000000001', v_workflow_id,
    v_claim.lease_epoch, v_claim.claim_token, v_message
  );
  select * into strict v_duplicate from public.runtime_enqueue_a2a_message(
    '41000000-0000-4000-8000-000000000001', v_workflow_id,
    v_claim.lease_epoch, v_claim.claim_token, v_message
  );
  if v_created.enqueue_status <> 'created' or v_duplicate.enqueue_status <> 'duplicate'
    or v_created.outbox_id <> v_duplicate.outbox_id then
    raise exception 'TEST_FAILURE [outbox idempotency]';
  end if;
  raise notice 'PASS [outbox idempotency]';

  v_rejected := false;
  begin
    perform public.runtime_enqueue_a2a_message(
      '41000000-0000-4000-8000-000000000001', v_workflow_id,
      v_claim.lease_epoch + 1, v_claim.claim_token, v_message
    );
  exception when sqlstate '55000' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [stale sender fence]'; end if;
  raise notice 'PASS [stale sender fence rejected]';

  v_rejected := false;
  begin
    perform public.runtime_enqueue_a2a_message(
      '41000000-0000-4000-8000-000000000001', v_workflow_id,
      v_claim.lease_epoch, v_claim.claim_token,
      jsonb_set(v_message, '{data}', '{"api_key":"forbidden"}'::jsonb)
    );
  exception when check_violation then v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [secret-bearing payload]'; end if;
  raise notice 'PASS [secret-bearing payload rejected]';

  select * into strict v_outbox_claim
  from public.runtime_claim_a2a_outbox('a2a-delivery-worker', 60, 1);
  if v_outbox_claim.message_id <> '41200000-0000-7000-8000-000000000001'::uuid
    or v_outbox_claim.lease_epoch <> 1 then
    raise exception 'TEST_FAILURE [outbox claim]';
  end if;
  raise notice 'PASS [outbox claimed with fence]';

  select * into strict v_received from public.runtime_receive_a2a_message(v_message);
  if v_received.receive_status <> 'created' then raise exception 'TEST_FAILURE [inbox receive]'; end if;
  select * into strict v_duplicate from public.runtime_receive_a2a_message(v_message);
  if v_duplicate.receive_status <> 'duplicate' or v_duplicate.inbox_id <> v_received.inbox_id then
    raise exception 'TEST_FAILURE [inbox idempotency]';
  end if;
  raise notice 'PASS [inbox idempotency]';

  select count(*) into v_count
  from public.runtime_claim_a2a_inbox('wrong-agent-worker', 'other-agent', 60, 1);
  if v_count <> 0 then raise exception 'TEST_FAILURE [recipient-scoped claim]'; end if;
  select * into strict v_inbox_claim
  from public.runtime_claim_a2a_inbox('proposal-worker', 'proposal', 60, 1);
  raise notice 'PASS [recipient-scoped inbox claim]';

  v_rejected := false;
  begin
    perform public.runtime_finish_a2a_processing(
      v_inbox_claim.account_id, v_inbox_claim.inbox_id,
      v_inbox_claim.lease_epoch + 1, v_inbox_claim.claim_token, true
    );
  exception when sqlstate '55000' then v_rejected := true;
  end;
  if not v_rejected then raise exception 'TEST_FAILURE [stale inbox fence]'; end if;
  if public.runtime_finish_a2a_processing(
    v_inbox_claim.account_id, v_inbox_claim.inbox_id,
    v_inbox_claim.lease_epoch, v_inbox_claim.claim_token, true
  ) <> 'processed' then raise exception 'TEST_FAILURE [inbox finish]'; end if;
  raise notice 'PASS [inbox processing fenced and completed]';

  if public.runtime_finish_a2a_delivery(
    v_outbox_claim.account_id, v_outbox_claim.outbox_id,
    v_outbox_claim.lease_epoch, v_outbox_claim.claim_token, true
  ) <> 'delivered' then raise exception 'TEST_FAILURE [outbox finish]'; end if;
  raise notice 'PASS [outbox delivery completed]';

  if has_table_privilege('anon', 'runtime.a2a_inbox_messages', 'SELECT')
    or has_table_privilege('authenticated', 'runtime.a2a_outbox_messages', 'SELECT')
    or has_function_privilege('anon', 'public.runtime_receive_a2a_message(jsonb)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.runtime_receive_a2a_message(jsonb)', 'EXECUTE') then
    raise exception 'TEST_FAILURE [A2A privileges]';
  end if;
  raise notice 'PASS [A2A tables and RPCs are service-role only]';
end
$$;

select pass('durable A2A preserves idempotency, fencing, tenant routing and service-role isolation');
select * from finish();

rollback;
