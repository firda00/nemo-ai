-- Negative checks for ADR 001 Durable Operations Runtime Phase 1.
-- Run only against an isolated disposable database after applying all migrations.
-- The transaction is always rolled back.

begin;

create function pg_temp.expect_rejection(
  p_test_name text,
  p_statement text,
  p_expected_sqlstate text,
  p_expected_constraint text default null
)
returns void
language plpgsql
as $$
declare
  v_sqlstate text;
  v_constraint text;
  v_message text;
begin
  begin
    execute p_statement;
  exception when others then
    get stacked diagnostics
      v_sqlstate = returned_sqlstate,
      v_constraint = constraint_name,
      v_message = message_text;

    if v_sqlstate <> p_expected_sqlstate then
      raise exception 'TEST_FAILURE [%]: expected SQLSTATE %, got %: %',
        p_test_name, p_expected_sqlstate, v_sqlstate, v_message;
    end if;
    if p_expected_constraint is not null and v_constraint <> p_expected_constraint then
      raise exception 'TEST_FAILURE [%]: expected constraint %, got %: %',
        p_test_name, p_expected_constraint, coalesce(v_constraint, '<none>'), v_message;
    end if;

    raise notice 'PASS [%]: rejected by SQLSTATE %, constraint %',
      p_test_name, v_sqlstate, coalesce(v_constraint, '<trigger>');
    return;
  end;

  raise exception 'TEST_FAILURE [%]: statement unexpectedly succeeded', p_test_name;
end;
$$;

insert into public.accounts (id, name)
values
  ('10000000-0000-4000-8000-000000000001', 'runtime-test-a'),
  ('20000000-0000-4000-8000-000000000002', 'runtime-test-b');

insert into runtime.inbox_events (
  id, account_id, provider, event_type, external_event_id, external_event_id_hash,
  identity_version, correlation_id, occurred_at, contract_version,
  normalization_result, payload, payload_hash
) values
  (
    '11000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'amocrm', 'DEAL_STAGE_CHANGED', 'event-a', repeat('a', 64), 'v1',
    '12000000-0000-4000-8000-000000000001', clock_timestamp(), 'crm-v1',
    'accepted', '{"deal_id":"a"}'::jsonb, repeat('1', 64)
  ),
  (
    '21000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'amocrm', 'DEAL_STAGE_CHANGED', 'event-b', repeat('b', 64), 'v1',
    '22000000-0000-4000-8000-000000000002', clock_timestamp(), 'crm-v1',
    'accepted', '{"deal_id":"b"}'::jsonb, repeat('2', 64)
  );

insert into runtime.workflow_runs (
  id, account_id, inbox_event_id, workflow_type, workflow_version,
  execution_mode, correlation_id
) values
  (
    '13000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '11000000-0000-4000-8000-000000000001',
    'amocrm_shadow_event', '1.0.0', 'shadow',
    '12000000-0000-4000-8000-000000000001'
  ),
  (
    '23000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    '21000000-0000-4000-8000-000000000002',
    'amocrm_shadow_event', '1.0.0', 'shadow',
    '22000000-0000-4000-8000-000000000002'
  );

-- 1. A child carrying tenant A may not reference tenant B's workflow.
select pg_temp.expect_rejection(
  'tenant leakage composite FK',
  $sql$
    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, lease_epoch
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '23000000-0000-4000-8000-000000000002',
      1, 'received', 'queued', 'classified', 'system', 'test',
      '12000000-0000-4000-8000-000000000001', '1.0.0', 0
    )
  $sql$,
  '23503',
  'workflow_transitions_workflow_fkey'
);

-- 2. Audit rows are immutable even for a direct table writer.
insert into runtime.audit_events (
  id, account_id, event_type, actor_type, actor_id, correlation_id,
  details, runtime_contract_version
) values (
  '14000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'test.created', 'system', 'runtime-test',
  '12000000-0000-4000-8000-000000000001', '{}'::jsonb, 'runtime-v1'
);

select pg_temp.expect_rejection(
  'audit append-only',
  $sql$
    update runtime.audit_events
    set actor_id = 'hacker'
    where id = '14000000-0000-4000-8000-000000000001'
  $sql$,
  '55000'
);

-- 3. Payloads larger than 64 KiB are rejected by the database.
select pg_temp.expect_rejection(
  'inbox payload byte limit',
  $sql$
    insert into runtime.inbox_events (
      account_id, provider, event_type, external_event_id, external_event_id_hash,
      identity_version, correlation_id, occurred_at, contract_version,
      normalization_result, payload, payload_hash
    ) values (
      '10000000-0000-4000-8000-000000000001',
      'amocrm', 'DEAL_STAGE_CHANGED', 'oversized-event', repeat('c', 64), 'v1',
      gen_random_uuid(), clock_timestamp(), 'crm-v1', 'accepted',
      jsonb_build_object('blob', repeat('x', 71680)), repeat('3', 64)
    )
  $sql$,
  '23514',
  'inbox_events_payload_size_check'
);

-- Valid lineage used by the remaining negative checks.
insert into runtime.workflow_transitions (
  id, account_id, workflow_id, transition_seq, from_state, to_state,
  transition_type, actor_type, actor_id, correlation_id,
  workflow_version, lease_epoch
) values (
  '15000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001',
  1, 'received', 'waiting_for_policy', 'policy_requested',
  'system', 'runtime-test', '12000000-0000-4000-8000-000000000001',
  '1.0.0', 0
);

insert into runtime.policy_decisions (
  id, account_id, workflow_id, transition_id, ruleset_id, policy_version,
  decision, reasons, input_hash, action_payload_hash, canonicalization_version
) values (
  '16000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001',
  '15000000-0000-4000-8000-000000000001',
  'shadow-default', 'policy-v1', 'allow', '[]'::jsonb,
  repeat('4', 64), repeat('5', 64), 'canon-v1'
);

-- 4. A shadow action can only be terminal simulated; it can never masquerade as live-completed.
select pg_temp.expect_rejection(
  'shadow cannot use live status',
  $sql$
    insert into runtime.outbox_actions (
      account_id, workflow_id, transition_id, policy_decision_id,
      policy_version, connector_id, action_type, execution_mode, payload,
      action_payload_hash, canonicalization_version,
      idempotency_key, idempotency_key_hash, status, completed_at
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '13000000-0000-4000-8000-000000000001',
      '15000000-0000-4000-8000-000000000001',
      '16000000-0000-4000-8000-000000000001',
      'policy-v1', 'amocrm', 'create_task', 'shadow', '{}'::jsonb,
      repeat('5', 64), 'canon-v1', 'shadow-test', repeat('6', 64),
      'completed', clock_timestamp()
    )
  $sql$,
  '23514',
  'outbox_actions_shadow_invariants_check'
);

-- 5. A worker cannot create a partial lease or hold a lease outside running state.
select pg_temp.expect_rejection(
  'workflow lease tuple integrity',
  $sql$
    update runtime.workflow_runs
    set lease_holder = 'worker-without-fence'
    where id = '13000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'workflow_runs_lease_integrity_check'
);

-- Exact matrix enforcement: valid state names do not make an invalid pair legal.
select pg_temp.expect_rejection(
  'invalid state pair',
  $sql$
    insert into runtime.workflow_transitions (
      account_id, workflow_id, transition_seq, from_state, to_state,
      transition_type, actor_type, actor_id, correlation_id,
      workflow_version, lease_epoch
    ) values (
      '10000000-0000-4000-8000-000000000001',
      '13000000-0000-4000-8000-000000000001',
      2, 'queued', 'completed', 'completed', 'system', 'test',
      '12000000-0000-4000-8000-000000000001', '1.0.0', 0
    )
  $sql$,
  '23503',
  'workflow_transitions_pair_fkey'
);

do $$
begin
  if has_schema_privilege('anon', 'runtime', 'usage')
    or has_schema_privilege('authenticated', 'runtime', 'usage') then
    raise exception 'TEST_FAILURE [schema isolation]: browser role has runtime usage';
  end if;
  raise notice 'PASS [schema isolation]: anon/authenticated have no runtime schema usage';
end;
$$;

rollback;
