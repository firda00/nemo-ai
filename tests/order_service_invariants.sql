-- ADR 004 order service invariants: FSM fencing, idempotent creation, all-or-nothing multi-SKU
-- reservation, leased outbox claim/finish, consumer-inbox dedupe, append-only transitions, tenant
-- isolation, closed-schema grants, payload bounds.
-- Run only against an isolated disposable database after applying all migrations.
-- The transaction is always rolled back. Deterministic lock ordering under REAL concurrent
-- contention (not exercised here — this is a single-transaction test) is covered instead by
-- tests/order_service_concurrency.ps1, which launches parallel psql processes against a disposable
-- reset database, mirroring tests/billing_concurrency_reserve.ps1's split for the same reason.

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

create function pg_temp.expect(p_test_name text, p_condition boolean, p_detail text default '')
returns void
language plpgsql
as $$
begin
  if not p_condition then
    raise exception 'TEST_FAILURE [%]: %', p_test_name, p_detail;
  end if;
  raise notice 'PASS [%]', p_test_name;
end;
$$;

insert into public.accounts (id, name) values
  ('90000000-0000-4000-8000-000000000001', 'order-service-test-a'),
  ('90000000-0000-4000-8000-000000000002', 'order-service-test-b');

insert into commerce_runtime.inventory (account_id, product_id, available, reserved) values
  ('90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 5, 0),
  ('90000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 3, 0);

-- ---------------------------------------------------------------------------------------------
-- Tenant FK isolation
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order_a jsonb;
  v_order_b jsonb;
begin
  v_order_a := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'tenant-fk-a', 'USD', 1000
  );
  v_order_b := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000002', 'tenant-fk-b', 'USD', 1000
  );

  perform pg_temp.expect_rejection(
    'tenant leakage composite FK on order_transitions',
    format(
      $sql$
        insert into commerce_runtime.order_transitions (
          account_id, order_id, transition_seq, from_state, to_state,
          actor_type, actor_id, transition_payload
        ) values (
          '90000000-0000-4000-8000-000000000001', %L, 99, 'created', 'cancelled',
          'system', 'test', '{}'::jsonb
        )
      $sql$,
      v_order_b ->> 'order_id'
    ),
    '23503',
    'order_transitions_order_fkey'
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Idempotent order creation: replay on matching payload, collision on mismatched payload,
-- atomicity of order + initial transition + outbox event.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_first jsonb;
  v_replay jsonb;
  v_collision jsonb;
  v_order_id uuid;
  v_order_count int;
  v_transition_count int;
  v_outbox_count int;
begin
  v_first := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'idem-key-1', 'USD', 2500, 'cust-1',
    '{"note":"first"}'::jsonb
  );
  perform pg_temp.expect('create_order returns created', v_first ->> 'status' = 'created', v_first::text);
  v_order_id := (v_first ->> 'order_id')::uuid;

  v_replay := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'idem-key-1', 'USD', 2500, 'cust-1',
    '{"note":"first"}'::jsonb
  );
  perform pg_temp.expect(
    'identical retry replays the same order',
    (v_replay ->> 'order_id')::uuid = v_order_id and (v_replay ->> 'idempotent_replay')::boolean,
    v_replay::text
  );

  v_collision := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'idem-key-1', 'USD', 999999, 'cust-1',
    '{"note":"first"}'::jsonb
  );
  perform pg_temp.expect(
    'mismatched payload under same key is a rejected collision',
    v_collision ->> 'status' = 'idempotency_key_collision',
    v_collision::text
  );

  select count(*) into v_order_count from commerce_runtime.orders where id = v_order_id;
  select count(*) into v_transition_count
    from commerce_runtime.order_transitions where order_id = v_order_id;
  select count(*) into v_outbox_count
    from commerce_runtime.order_outbox_events where order_id = v_order_id;

  perform pg_temp.expect('exactly one order row', v_order_count = 1, v_order_count::text);
  perform pg_temp.expect(
    'exactly one birth transition row (create + transition + outbox atomicity)',
    v_transition_count = 1, v_transition_count::text
  );
  perform pg_temp.expect(
    'exactly one birth outbox event row', v_outbox_count = 1, v_outbox_count::text
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- FSM transitions: invalid pair rejection, stale expected_state_version rejection, valid
-- transition + outbox atomicity.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_created jsonb;
  v_order_id uuid;
  v_transition jsonb;
  v_transition_count int;
  v_outbox_count int;
  v_status text;
  v_version bigint;
begin
  v_created := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'transition-key-1', 'USD', 500
  );
  v_order_id := (v_created ->> 'order_id')::uuid;

  perform pg_temp.expect_rejection(
    'invalid transition pair rejected',
    format(
      $sql$select commerce_runtime.transition_order(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, 0, 'shipped',
        'system', 'test-actor'
      )$sql$,
      v_order_id
    ),
    '23503',
    'order_transitions_pair_fkey'
  );

  perform pg_temp.expect_rejection(
    'stale expected_state_version rejected',
    format(
      $sql$select commerce_runtime.transition_order(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, 7, 'cancelled',
        'system', 'test-actor'
      )$sql$,
      v_order_id
    ),
    '55000'
  );

  v_transition := commerce_runtime.transition_order(
    '90000000-0000-4000-8000-000000000001', v_order_id, 0, 'cancelled', 'system', 'test-actor'
  );
  perform pg_temp.expect(
    'valid transition succeeds', v_transition ->> 'status' = 'transitioned', v_transition::text
  );

  select status, state_version into v_status, v_version
  from commerce_runtime.orders where id = v_order_id;
  perform pg_temp.expect('order status updated', v_status = 'cancelled', v_status);
  perform pg_temp.expect('state_version incremented', v_version = 1, v_version::text);

  select count(*) into v_transition_count
    from commerce_runtime.order_transitions where order_id = v_order_id;
  select count(*) into v_outbox_count
    from commerce_runtime.order_outbox_events where order_id = v_order_id;
  perform pg_temp.expect(
    'transition + outbox atomicity: birth + this transition = 2 rows',
    v_transition_count = 2, v_transition_count::text
  );
  perform pg_temp.expect(
    'transition + outbox atomicity: birth + this event = 2 outbox rows',
    v_outbox_count = 2, v_outbox_count::text
  );

  -- A second call with the already-superseded expected version is now stale too.
  perform pg_temp.expect_rejection(
    'retry with old version after a real transition is stale',
    format(
      $sql$select commerce_runtime.transition_order(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, 0, 'created',
        'system', 'test-actor'
      )$sql$,
      v_order_id
    ),
    '55000'
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Inventory reservation: single-SKU success, multi-SKU duplicate aggregation, all-or-nothing on
-- partial insufficiency, no negative stock via direct table mutation.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order_single jsonb;
  v_order_multi jsonb;
  v_order_short jsonb;
  v_reserve jsonb;
  v_available_1 bigint;
  v_reserved_1 bigint;
  v_available_2 bigint;
  v_reserved_2 bigint;
  v_status text;
begin
  -- Single-SKU reservation.
  v_order_single := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-single', 'USD', 100
  );
  v_reserve := commerce_runtime.reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_single ->> 'order_id')::uuid,
    0,
    jsonb_build_array(
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000001', 'quantity', 2)
    )
  );
  perform pg_temp.expect(
    'single-SKU reservation succeeds', v_reserve ->> 'status' = 'transitioned', v_reserve::text
  );

  select available, reserved into v_available_1, v_reserved_1
  from commerce_runtime.inventory
  where account_id = '90000000-0000-4000-8000-000000000001'
    and product_id = '91000000-0000-4000-8000-000000000001';
  perform pg_temp.expect('available decremented by 2', v_available_1 = 3, v_available_1::text);
  perform pg_temp.expect('reserved incremented by 2', v_reserved_1 = 2, v_reserved_1::text);

  select status into v_status
  from commerce_runtime.orders where id = (v_order_single ->> 'order_id')::uuid;
  perform pg_temp.expect('order moved to reserved', v_status = 'reserved', v_status);

  -- Multi-SKU reservation with a duplicate product id in the request: must aggregate, not
  -- double-count or bypass the stock check by splitting into two smaller-looking lines.
  v_order_multi := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-multi-dup', 'USD', 200
  );
  v_reserve := commerce_runtime.reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_multi ->> 'order_id')::uuid,
    0,
    jsonb_build_array(
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000001', 'quantity', 1),
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000001', 'quantity', 1),
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000002', 'quantity', 1)
    )
  );
  perform pg_temp.expect(
    'multi-SKU reservation with duplicate SKU succeeds', v_reserve ->> 'status' = 'transitioned',
    v_reserve::text
  );
  perform pg_temp.expect(
    'duplicate SKU lines aggregated into one reserved_item_count entry',
    (v_reserve ->> 'reserved_item_count')::int = 2, v_reserve::text
  );

  select available, reserved into v_available_1, v_reserved_1
  from commerce_runtime.inventory
  where account_id = '90000000-0000-4000-8000-000000000001'
    and product_id = '91000000-0000-4000-8000-000000000001';
  perform pg_temp.expect(
    'duplicate SKU quantities summed (1+1=2), available now 1',
    v_available_1 = 1, v_available_1::text
  );

  select available, reserved into v_available_2, v_reserved_2
  from commerce_runtime.inventory
  where account_id = '90000000-0000-4000-8000-000000000001'
    and product_id = '91000000-0000-4000-8000-000000000002';
  perform pg_temp.expect('second SKU decremented by 1', v_available_2 = 2, v_available_2::text);

  -- All-or-nothing: product 1 has only 1 unit left; request 1 (fine) + product 2 request 999
  -- (impossible). Neither line should move.
  v_order_short := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-short', 'USD', 300
  );
  v_reserve := commerce_runtime.reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_short ->> 'order_id')::uuid,
    0,
    jsonb_build_array(
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000001', 'quantity', 1),
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000002', 'quantity', 999)
    )
  );
  perform pg_temp.expect(
    'partially-satisfiable reservation is denied, not partially applied',
    v_reserve ->> 'status' = 'denied_insufficient_stock', v_reserve::text
  );

  select available into v_available_1
  from commerce_runtime.inventory
  where account_id = '90000000-0000-4000-8000-000000000001'
    and product_id = '91000000-0000-4000-8000-000000000001';
  perform pg_temp.expect(
    'the satisfiable line was NOT reserved (all-or-nothing)', v_available_1 = 1, v_available_1::text
  );

  select status into v_status
  from commerce_runtime.orders where id = (v_order_short ->> 'order_id')::uuid;
  perform pg_temp.expect(
    'denied reservation leaves the order in created, not reserved', v_status = 'created', v_status
  );

  -- Unknown product id.
  v_reserve := commerce_runtime.reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_short ->> 'order_id')::uuid,
    0,
    jsonb_build_array(
      jsonb_build_object('product_id', '91000000-0000-4000-8000-00000000ffff', 'quantity', 1)
    )
  );
  perform pg_temp.expect(
    'unknown product id is reported as missing, not silently ignored',
    v_reserve ->> 'status' = 'denied_missing_inventory_row', v_reserve::text
  );
end;
$$;

select pg_temp.expect_rejection(
  'inventory available cannot go negative',
  $sql$
    update commerce_runtime.inventory
    set available = -1
    where account_id = '90000000-0000-4000-8000-000000000001'
      and product_id = '91000000-0000-4000-8000-000000000001'
  $sql$,
  '23514',
  'inventory_available_check'
);

-- ---------------------------------------------------------------------------------------------
-- Consumer inbox: same external message id is dedupe-ignored on the second delivery, in the same
-- transaction as the mutation it would otherwise re-apply.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_transition_count int;
begin
  v_order := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'inbox-key-1', 'USD', 400
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  v_first := commerce_runtime.consume_order_event(
    '90000000-0000-4000-8000-000000000001', 'orders.payment-confirmed', 'kafka-msg-1',
    v_order_id, 0, 'cancelled', 'worker', 'payment-worker-1'
  );
  perform pg_temp.expect(
    'first delivery applies the mutation', v_first ->> 'status' = 'transitioned', v_first::text
  );

  v_second := commerce_runtime.consume_order_event(
    '90000000-0000-4000-8000-000000000001', 'orders.payment-confirmed', 'kafka-msg-1',
    v_order_id, 1, 'created', 'worker', 'payment-worker-1'
  );
  perform pg_temp.expect(
    'redelivery of the same message id is dedupe-ignored',
    v_second ->> 'status' = 'duplicate_ignored', v_second::text
  );

  select count(*) into v_transition_count
  from commerce_runtime.order_transitions where order_id = v_order_id;
  perform pg_temp.expect(
    'redelivery did not apply a second mutation (birth + one transition only)',
    v_transition_count = 2, v_transition_count::text
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Leased outbox claim/finish: unique claim while leased, fenced finish, expired-lease reclaim.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_claim record;
  v_second_claim_count int;
  v_finish jsonb;
  v_reclaim record;
  v_reclaim_count int;
begin
  v_order := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'outbox-claim-key', 'USD', 600
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  select * into v_claim
  from commerce_runtime.claim_order_outbox_events('worker-1', 300, 10)
  where order_id = v_order_id
  limit 1;
  perform pg_temp.expect('birth event claimable', v_claim.outbox_event_id is not null, 'no row claimed');

  select count(*) into v_second_claim_count
  from commerce_runtime.claim_order_outbox_events('worker-2', 300, 10)
  where outbox_event_id = v_claim.outbox_event_id;
  perform pg_temp.expect(
    'a second worker cannot claim an already-leased event',
    v_second_claim_count = 0, v_second_claim_count::text
  );

  perform pg_temp.expect_rejection(
    'finish with wrong claim_token is rejected',
    format(
      $sql$select commerce_runtime.finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        gen_random_uuid(), 'published', 'worker-1'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch
    ),
    '55000'
  );

  perform pg_temp.expect_rejection(
    'finish with wrong lease_epoch is rejected',
    format(
      $sql$select commerce_runtime.finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'published', 'worker-1'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch + 1, v_claim.claim_token
    ),
    '55000'
  );

  v_finish := commerce_runtime.finish_order_outbox_event(
    '90000000-0000-4000-8000-000000000001', v_claim.outbox_event_id, v_claim.lease_epoch,
    v_claim.claim_token, 'published', 'worker-1'
  );
  perform pg_temp.expect('finish publishes', v_finish ->> 'status' = 'published', v_finish::text);

  -- A stale finish after the event already moved on is rejected too (status <> processing).
  perform pg_temp.expect_rejection(
    'finish after the event already left processing is rejected',
    format(
      $sql$select commerce_runtime.finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'published', 'worker-1'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch, v_claim.claim_token
    ),
    '55000'
  );

  -- Reclaim: simulate an abandoned lease by claiming a fresh event, then back-dating its lease
  -- directly (standing in for real time passing), and proving a second claim call reclaims it
  -- with a bumped lease_epoch that fences out the abandoned worker's eventual (late) finish call.
  perform commerce_runtime.transition_order(
    '90000000-0000-4000-8000-000000000001', v_order_id, 0, 'cancelled', 'system', 'reclaim-setup'
  );

  select * into v_claim
  from commerce_runtime.claim_order_outbox_events('worker-abandoned', 300, 10)
  where order_id = v_order_id
  limit 1;
  perform pg_temp.expect(
    'transition event claimable for reclaim setup', v_claim.outbox_event_id is not null, ''
  );

  update commerce_runtime.order_outbox_events
  set lease_until = clock_timestamp() - interval '1 minute'
  where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id;

  select * into v_reclaim
  from commerce_runtime.claim_order_outbox_events('worker-recovering', 300, 10)
  where outbox_event_id = v_claim.outbox_event_id
  limit 1;

  select count(*) into v_reclaim_count
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001'
    and id = v_claim.outbox_event_id
    and lease_epoch = v_claim.lease_epoch + 1
    and claim_token = v_reclaim.claim_token
    and claim_token <> v_claim.claim_token;
  perform pg_temp.expect(
    'expired lease reclaimed with a bumped lease_epoch and a new claim_token',
    v_reclaim_count = 1, v_reclaim_count::text
  );

  perform pg_temp.expect_rejection(
    'the abandoned worker''s late finish is fenced out by the old lease_epoch/claim_token',
    format(
      $sql$select commerce_runtime.finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'published', 'worker-abandoned'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch, v_claim.claim_token
    ),
    '55000'
  );

  v_finish := commerce_runtime.finish_order_outbox_event(
    '90000000-0000-4000-8000-000000000001', v_reclaim.outbox_event_id, v_reclaim.lease_epoch,
    v_reclaim.claim_token, 'published', 'worker-recovering'
  );
  perform pg_temp.expect(
    'the reclaiming worker finishes successfully', v_finish ->> 'status' = 'published', v_finish::text
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Bounded exponential backoff + auto dead-letter on attempt-budget exhaustion.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_claim record;
  v_finish jsonb;
  v_max_attempts int := 8;
  i int;
begin
  v_order := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'outbox-deadletter-key', 'USD', 700
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  for i in 1..v_max_attempts loop
    select * into v_claim
    from commerce_runtime.claim_order_outbox_events('worker-retry', 1, 10)
    where order_id = v_order_id
    limit 1;
    exit when v_claim.outbox_event_id is null;

    v_finish := commerce_runtime.finish_order_outbox_event(
      '90000000-0000-4000-8000-000000000001', v_claim.outbox_event_id, v_claim.lease_epoch,
      v_claim.claim_token, 'retry_scheduled', 'worker-retry', clock_timestamp()
    );

    -- Force the retry's backoff window to have already elapsed so the next loop iteration can
    -- reclaim it immediately instead of waiting out the real backoff interval.
    update commerce_runtime.order_outbox_events
    set next_attempt_at = clock_timestamp() - interval '1 second'
    where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id
      and status = 'retry_scheduled';
  end loop;

  perform pg_temp.expect(
    'attempt budget exhausted, event auto-upgraded to dead_letter',
    v_finish ->> 'status' = 'dead_letter', v_finish::text
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Append-only order_transitions enforcement — a direct table writer is blocked too, not just the
-- RPC surface.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
begin
  v_order := commerce_runtime.create_order(
    '90000000-0000-4000-8000-000000000001', 'append-only-key', 'USD', 800
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  perform pg_temp.expect_rejection(
    'order_transitions update blocked',
    format(
      $sql$update commerce_runtime.order_transitions set actor_id = 'hacker' where order_id = %L$sql$,
      v_order_id
    ),
    '0OS01'
  );

  perform pg_temp.expect_rejection(
    'order_transitions delete blocked',
    format(
      $sql$delete from commerce_runtime.order_transitions where order_id = %L$sql$,
      v_order_id
    ),
    '0OS01'
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Payload bounds — the RPC's own validation rejects an oversized payload before any row is
-- touched, and the table CHECK constraints reject it too as defense in depth against any future
-- code path that writes these tables directly.
-- ---------------------------------------------------------------------------------------------

select pg_temp.expect_rejection(
  'create_order rejects an oversized order_payload at the RPC layer',
  $sql$
    select commerce_runtime.create_order(
      '90000000-0000-4000-8000-000000000001'::uuid, 'oversized-payload-key', 'USD', 100, null,
      jsonb_build_object('blob', repeat('x', 70000))
    )
  $sql$,
  '22023'
);

select pg_temp.expect_rejection(
  'orders table itself rejects an oversized order_payload (defense in depth)',
  $sql$
    insert into commerce_runtime.orders (
      account_id, idempotency_key, payload_hash, status, state_version,
      currency, total_amount_minor, order_payload
    ) values (
      '90000000-0000-4000-8000-000000000001', 'raw-oversized-key', repeat('0', 64), 'created', 0,
      'USD', 100, jsonb_build_object('blob', repeat('x', 70000))
    )
  $sql$,
  '23514',
  'orders_payload_size_check'
);

select pg_temp.expect_rejection(
  'order_transitions table itself rejects an oversized transition_payload',
  $sql$
    insert into commerce_runtime.order_transitions (
      account_id, order_id, transition_seq, from_state, to_state,
      actor_type, actor_id, transition_payload
    ) values (
      '90000000-0000-4000-8000-000000000001', gen_random_uuid(), 1, 'new', 'created',
      'system', 'test', jsonb_build_object('blob', repeat('x', 20000))
    )
  $sql$,
  '23514',
  'order_transitions_payload_size_check'
);

-- ---------------------------------------------------------------------------------------------
-- Closed-schema grants: no direct table/schema access for anon or authenticated.
-- ---------------------------------------------------------------------------------------------

do $$
begin
  if has_schema_privilege('anon', 'commerce_runtime', 'usage')
    or has_schema_privilege('authenticated', 'commerce_runtime', 'usage') then
    raise exception 'TEST_FAILURE [schema isolation]: browser role has commerce_runtime usage';
  end if;
  raise notice 'PASS [schema isolation]: anon/authenticated have no commerce_runtime schema usage';

  if has_table_privilege('anon', 'commerce_runtime.orders', 'select')
    or has_table_privilege('authenticated', 'commerce_runtime.orders', 'select') then
    raise exception 'TEST_FAILURE [table isolation]: browser role can read commerce_runtime.orders';
  end if;
  raise notice 'PASS [table isolation]: anon/authenticated cannot read commerce_runtime.orders';

  if has_function_privilege('anon', 'commerce_runtime.create_order(uuid, text, text, bigint, text, jsonb, text)', 'execute')
    or has_function_privilege('authenticated', 'commerce_runtime.create_order(uuid, text, text, bigint, text, jsonb, text)', 'execute') then
    raise exception 'TEST_FAILURE [rpc isolation]: browser role can execute create_order';
  end if;
  raise notice 'PASS [rpc isolation]: anon/authenticated cannot execute commerce_runtime.create_order';
end;
$$;

rollback;
