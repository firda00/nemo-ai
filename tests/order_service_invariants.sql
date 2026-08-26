-- ADR 004 order service invariants: FSM fencing, idempotent creation, all-or-nothing multi-SKU
-- reservation, leased outbox claim/finish, consumer-inbox dedupe, append-only transitions, tenant
-- isolation, closed-schema grants, payload bounds.
-- Run only against an isolated disposable database after applying all migrations.
-- The transaction is always rolled back. Deterministic lock ordering under REAL concurrent
-- contention (not exercised here — this is a single-transaction test) is covered instead by
-- tests/order_service_concurrency.ps1, which launches parallel psql processes against a disposable
-- reset database, mirroring tests/billing_concurrency_reserve.ps1's split for the same reason.
--
-- All RPC calls below go through the public.commerce_* wrappers, not commerce_runtime.* directly —
-- those wrappers are the only contract a Supabase/PostgREST caller (or an Edge Function using the
-- service-role client) can actually reach, so exercising them here is exercising the real surface.

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
  v_order_a := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'tenant-fk-a', 'USD', 1000
  );
  v_order_b := public.commerce_create_order(
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
-- atomicity of order + initial transition + outbox event, birth state_version/transition_seq.
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
  v_birth_seq bigint;
  v_state_version bigint;
begin
  v_first := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'idem-key-1', 'USD', 2500, 'cust-1',
    '{"note":"first"}'::jsonb
  );
  perform pg_temp.expect('create_order returns created', v_first ->> 'status' = 'created', v_first::text);
  perform pg_temp.expect(
    'created order is born at state_version = 1, not 0',
    (v_first ->> 'state_version')::bigint = 1, v_first::text
  );
  v_order_id := (v_first ->> 'order_id')::uuid;

  select transition_seq into v_birth_seq
  from commerce_runtime.order_transitions
  where order_id = v_order_id and from_state = 'new';
  perform pg_temp.expect(
    'birth transition_seq is 1, matching the order''s birth state_version',
    v_birth_seq = 1, v_birth_seq::text
  );

  select state_version into v_state_version from commerce_runtime.orders where id = v_order_id;
  perform pg_temp.expect(
    'orders.state_version equals the birth transition_seq (both 1)',
    v_state_version = v_birth_seq, format('state_version=%s transition_seq=%s', v_state_version, v_birth_seq)
  );

  v_replay := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'idem-key-1', 'USD', 2500, 'cust-1',
    '{"note":"first"}'::jsonb
  );
  perform pg_temp.expect(
    'identical retry replays the same order',
    (v_replay ->> 'order_id')::uuid = v_order_id and (v_replay ->> 'idempotent_replay')::boolean,
    v_replay::text
  );

  v_collision := public.commerce_create_order(
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
-- transition + outbox atomicity. expected_state_version starts at 1 (the birth version), not 0.
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
  v_created := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'transition-key-1', 'USD', 500
  );
  v_order_id := (v_created ->> 'order_id')::uuid;

  perform pg_temp.expect_rejection(
    'invalid transition pair rejected',
    format(
      $sql$select public.commerce_transition_order(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, 1, 'shipped',
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
      $sql$select public.commerce_transition_order(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, 7, 'cancelled',
        'system', 'test-actor'
      )$sql$,
      v_order_id
    ),
    '55000'
  );

  v_transition := public.commerce_transition_order(
    '90000000-0000-4000-8000-000000000001', v_order_id, 1, 'cancelled', 'system', 'test-actor'
  );
  perform pg_temp.expect(
    'valid transition succeeds', v_transition ->> 'status' = 'transitioned', v_transition::text
  );

  select status, state_version into v_status, v_version
  from commerce_runtime.orders where id = v_order_id;
  perform pg_temp.expect('order status updated', v_status = 'cancelled', v_status);
  perform pg_temp.expect(
    'state_version incremented from birth (1) to 2', v_version = 2, v_version::text
  );

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

  -- A second call with the already-superseded expected version (the pre-transition version, 1) is
  -- now stale too.
  perform pg_temp.expect_rejection(
    'retry with old version after a real transition is stale',
    format(
      $sql$select public.commerce_transition_order(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, 1, 'created',
        'system', 'test-actor'
      )$sql$,
      v_order_id
    ),
    '55000'
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Inventory reservation: single-SKU success, multi-SKU duplicate aggregation, all-or-nothing
-- atomic rejection (order moves to inventory_rejected, not left in created), missing-row handling
-- without an unlocked pre-check race window, no negative stock via direct table mutation.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order_single jsonb;
  v_order_multi jsonb;
  v_order_short jsonb;
  v_order_missing jsonb;
  v_reserve jsonb;
  v_available_1 bigint;
  v_reserved_1 bigint;
  v_available_2 bigint;
  v_reserved_2 bigint;
  v_status text;
begin
  -- Single-SKU reservation.
  v_order_single := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-single', 'USD', 100
  );
  v_reserve := public.commerce_reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_single ->> 'order_id')::uuid,
    1,
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
  perform pg_temp.expect('order moved to inventory_reserved', v_status = 'inventory_reserved', v_status);

  -- Multi-SKU reservation with a duplicate product id in the request: must aggregate, not
  -- double-count or bypass the stock check by splitting into two smaller-looking lines.
  v_order_multi := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-multi-dup', 'USD', 200
  );
  v_reserve := public.commerce_reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_multi ->> 'order_id')::uuid,
    1,
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
  -- (impossible). Neither line should move, and the order is atomically rejected rather than left
  -- in created.
  v_order_short := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-short', 'USD', 300
  );
  v_reserve := public.commerce_reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_short ->> 'order_id')::uuid,
    1,
    jsonb_build_array(
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000001', 'quantity', 1),
      jsonb_build_object('product_id', '91000000-0000-4000-8000-000000000002', 'quantity', 999)
    )
  );
  perform pg_temp.expect(
    'partially-satisfiable reservation is atomically rejected, not partially applied',
    v_reserve ->> 'status' = 'inventory_rejected', v_reserve::text
  );
  perform pg_temp.expect(
    'rejection payload lists the short line',
    jsonb_array_length(v_reserve -> 'short') = 1, v_reserve::text
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
    'denied reservation moves the order to inventory_rejected, not left in created',
    v_status = 'inventory_rejected', v_status
  );

  -- Unknown product id: a fresh order, since v_order_short already transitioned to a terminal
  -- branch above and reserve_inventory only accepts orders in created.
  v_order_missing := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'reserve-missing', 'USD', 150
  );
  v_reserve := public.commerce_reserve_inventory(
    '90000000-0000-4000-8000-000000000001',
    (v_order_missing ->> 'order_id')::uuid,
    1,
    jsonb_build_array(
      jsonb_build_object('product_id', '91000000-0000-4000-8000-00000000ffff', 'quantity', 1)
    )
  );
  perform pg_temp.expect(
    'unknown product id is reported as missing, not silently ignored',
    v_reserve ->> 'status' = 'inventory_rejected', v_reserve::text
  );
  perform pg_temp.expect(
    'rejection payload lists the missing product id',
    jsonb_array_length(v_reserve -> 'missing_product_ids') = 1, v_reserve::text
  );

  select status into v_status
  from commerce_runtime.orders where id = (v_order_missing ->> 'order_id')::uuid;
  perform pg_temp.expect(
    'missing-row rejection also moves the order to inventory_rejected',
    v_status = 'inventory_rejected', v_status
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
  v_order := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'inbox-key-1', 'USD', 400
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  v_first := public.commerce_consume_order_event(
    '90000000-0000-4000-8000-000000000001', 'orders.payment-confirmed', 'kafka-msg-1',
    v_order_id, 1, 'cancelled', 'worker', 'payment-worker-1'
  );
  perform pg_temp.expect(
    'first delivery applies the mutation', v_first ->> 'status' = 'transitioned', v_first::text
  );

  v_second := public.commerce_consume_order_event(
    '90000000-0000-4000-8000-000000000001', 'orders.payment-confirmed', 'kafka-msg-1',
    v_order_id, 2, 'created', 'worker', 'payment-worker-1'
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
-- Leased outbox claim/finish: unique claim while leased, fenced finish (token, epoch, and
-- lease_holder/worker_id all required), expired-lease reclaim, rejected 'failed' result status.
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
  v_order := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'outbox-claim-key', 'USD', 600
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  select * into v_claim
  from public.commerce_claim_order_outbox_events('worker-1', 300, 10)
  where order_id = v_order_id
  limit 1;
  perform pg_temp.expect('birth event claimable', v_claim.outbox_event_id is not null, 'no row claimed');

  select count(*) into v_second_claim_count
  from public.commerce_claim_order_outbox_events('worker-2', 300, 10)
  where outbox_event_id = v_claim.outbox_event_id;
  perform pg_temp.expect(
    'a second worker cannot claim an already-leased event',
    v_second_claim_count = 0, v_second_claim_count::text
  );

  perform pg_temp.expect_rejection(
    'finish rejects the unsupported ''failed'' result status',
    format(
      $sql$select public.commerce_finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'failed', 'worker-1'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch, v_claim.claim_token
    ),
    '22023'
  );

  perform pg_temp.expect_rejection(
    'finish with wrong claim_token is rejected',
    format(
      $sql$select public.commerce_finish_order_outbox_event(
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
      $sql$select public.commerce_finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'published', 'worker-1'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch + 1, v_claim.claim_token
    ),
    '55000'
  );

  perform pg_temp.expect_rejection(
    'finish with the right token/epoch but the wrong worker_id is rejected',
    format(
      $sql$select public.commerce_finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'published', 'worker-impersonator'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch, v_claim.claim_token
    ),
    '55000'
  );

  v_finish := public.commerce_finish_order_outbox_event(
    '90000000-0000-4000-8000-000000000001', v_claim.outbox_event_id, v_claim.lease_epoch,
    v_claim.claim_token, 'published', 'worker-1'
  );
  perform pg_temp.expect('finish publishes', v_finish ->> 'status' = 'published', v_finish::text);

  -- A stale finish after the event already moved on is rejected too (status <> processing).
  perform pg_temp.expect_rejection(
    'finish after the event already left processing is rejected',
    format(
      $sql$select public.commerce_finish_order_outbox_event(
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
  perform public.commerce_transition_order(
    '90000000-0000-4000-8000-000000000001', v_order_id, 1, 'cancelled', 'system', 'reclaim-setup'
  );

  select * into v_claim
  from public.commerce_claim_order_outbox_events('worker-abandoned', 300, 10)
  where order_id = v_order_id
  limit 1;
  perform pg_temp.expect(
    'transition event claimable for reclaim setup', v_claim.outbox_event_id is not null, ''
  );

  update commerce_runtime.order_outbox_events
  set lease_until = clock_timestamp() - interval '1 minute'
  where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id;

  select * into v_reclaim
  from public.commerce_claim_order_outbox_events('worker-recovering', 300, 10)
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
      $sql$select public.commerce_finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'published', 'worker-abandoned'
      )$sql$,
      v_claim.outbox_event_id, v_claim.lease_epoch, v_claim.claim_token
    ),
    '55000'
  );

  v_finish := public.commerce_finish_order_outbox_event(
    '90000000-0000-4000-8000-000000000001', v_reclaim.outbox_event_id, v_reclaim.lease_epoch,
    v_reclaim.claim_token, 'published', 'worker-recovering'
  );
  perform pg_temp.expect(
    'the reclaiming worker finishes successfully', v_finish ->> 'status' = 'published', v_finish::text
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Bounded exponential backoff + auto dead-letter on attempt-budget exhaustion, driven entirely by
-- finish (the worker keeps reporting retry_scheduled and keeps calling finish itself, each retry
-- now carrying the now-required sanitized error code).
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_noerr_order jsonb;
  v_noerr_claim record;
  v_claim record;
  v_finish jsonb;
  v_max_attempts int := 8;
  i int;
begin
  -- A dedicated order/event for the missing-error-code check, kept separate from the dead-letter
  -- loop's target order below so a rejected finish call here cannot leave that event's lease/
  -- attempt_count in a state the loop does not expect.
  v_noerr_order := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'outbox-noerr-key', 'USD', 650
  );
  select * into v_noerr_claim
  from public.commerce_claim_order_outbox_events('worker-noerr', 300, 10)
  where order_id = (v_noerr_order ->> 'order_id')::uuid
  limit 1;
  perform pg_temp.expect_rejection(
    'finish rejects retry_scheduled with no error code',
    format(
      $sql$select public.commerce_finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'retry_scheduled', 'worker-noerr'
      )$sql$,
      v_noerr_claim.outbox_event_id, v_noerr_claim.lease_epoch, v_noerr_claim.claim_token
    ),
    '22023'
  );
  perform pg_temp.expect_rejection(
    'finish rejects dead_letter with no error code',
    format(
      $sql$select public.commerce_finish_order_outbox_event(
        '90000000-0000-4000-8000-000000000001'::uuid, %L::uuid, %L::bigint,
        %L::uuid, 'dead_letter', 'worker-noerr'
      )$sql$,
      v_noerr_claim.outbox_event_id, v_noerr_claim.lease_epoch, v_noerr_claim.claim_token
    ),
    '22023'
  );

  v_order := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'outbox-deadletter-key', 'USD', 700
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  for i in 1..v_max_attempts loop
    select * into v_claim
    from public.commerce_claim_order_outbox_events('worker-retry', 1, 10)
    where order_id = v_order_id
    limit 1;
    exit when v_claim.outbox_event_id is null;

    v_finish := public.commerce_finish_order_outbox_event(
      '90000000-0000-4000-8000-000000000001', v_claim.outbox_event_id, v_claim.lease_epoch,
      v_claim.claim_token, 'retry_scheduled', 'worker-retry', clock_timestamp(),
      'KAFKA_PUBLISH_TIMEOUT', 'publish attempt timed out'
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
-- Self-healing: an event whose lease expires on its FINAL attempt (attempt_count already at
-- max_attempts) without finish ever being called is dead-lettered by claim itself, not left stuck
-- in processing forever.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_claim record;
  v_status text;
  v_reclaim_count int;
begin
  v_order := public.commerce_create_order(
    '90000000-0000-4000-8000-000000000001', 'outbox-selfheal-key', 'USD', 750
  );
  v_order_id := (v_order ->> 'order_id')::uuid;

  -- Drive attempt_count to max_attempts (8) via repeated claim + immediate expiry, without ever
  -- calling finish, so the row is left 'processing' with attempt_count = max_attempts on its last
  -- claim.
  for i in 1..8 loop
    select * into v_claim
    from public.commerce_claim_order_outbox_events('worker-stuck', 1, 10)
    where order_id = v_order_id
    limit 1;
    exit when v_claim.outbox_event_id is null;

    update commerce_runtime.order_outbox_events
    set lease_until = clock_timestamp() - interval '1 minute'
    where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id;
  end loop;

  select status into v_status
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id;
  perform pg_temp.expect(
    'setup: event is stuck processing with an expired lease and exhausted attempts',
    v_status = 'processing', v_status
  );

  -- A subsequent claim call must not return this row as claimable (attempts are exhausted)...
  select count(*) into v_reclaim_count
  from public.commerce_claim_order_outbox_events('worker-sweeper', 300, 50)
  where outbox_event_id = v_claim.outbox_event_id;
  perform pg_temp.expect(
    'the exhausted-and-expired event is not handed out as a new claim',
    v_reclaim_count = 0, v_reclaim_count::text
  );

  -- ...but claim's own self-heal must have dead-lettered it in the process, in the same statement.
  select status into v_status
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id;
  perform pg_temp.expect(
    'claim self-heals the exhausted expired lease to dead_letter instead of leaving it stuck',
    v_status = 'dead_letter', v_status
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Bounded self-heal: a large backlog of exhausted, expired processing rows must not all be
-- dead-lettered by a single claim call — only up to p_limit of them, so an outage backlog cannot
-- turn one claim into an unbounded transaction.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_order jsonb;
  v_order_id uuid;
  v_claim record;
  v_event_ids uuid[] := array[]::uuid[];
  v_dead_letter_count int;
  v_still_processing_count int;
  i int;
  j int;
begin
  -- Build 3 independent orders/events, each individually driven to 'processing' with an expired
  -- lease and attempt_count = max_attempts (8), exactly like the single-row self-heal setup above.
  for i in 1..3 loop
    v_order := public.commerce_create_order(
      '90000000-0000-4000-8000-000000000001', format('outbox-bounded-selfheal-key-%s', i), 'USD', 760 + i
    );
    v_order_id := (v_order ->> 'order_id')::uuid;

    for j in 1..8 loop
      select * into v_claim
      from public.commerce_claim_order_outbox_events(format('worker-bounded-stuck-%s', i), 1, 10)
      where order_id = v_order_id
      limit 1;
      exit when v_claim.outbox_event_id is null;

      update commerce_runtime.order_outbox_events
      set lease_until = clock_timestamp() - interval '1 minute'
      where account_id = '90000000-0000-4000-8000-000000000001' and id = v_claim.outbox_event_id;
    end loop;

    v_event_ids := v_event_ids || v_claim.outbox_event_id;
  end loop;

  select count(*) into v_still_processing_count
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001' and id = any (v_event_ids) and status = 'processing';
  perform pg_temp.expect(
    'setup: all 3 events are stuck processing with expired, exhausted leases',
    v_still_processing_count = 3, v_still_processing_count::text
  );

  -- A single claim call with p_limit = 2 must dead-letter at most 2 of the 3 exhausted rows.
  perform public.commerce_claim_order_outbox_events('worker-bounded-sweeper', 300, 2);

  select count(*) into v_dead_letter_count
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001' and id = any (v_event_ids) and status = 'dead_letter';
  perform pg_temp.expect(
    'one bounded claim call dead-letters at most p_limit exhausted rows, not the whole backlog',
    v_dead_letter_count <= 2, v_dead_letter_count::text
  );

  select count(*) into v_still_processing_count
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001' and id = any (v_event_ids) and status = 'processing';
  perform pg_temp.expect(
    'the remaining exhausted rows past p_limit are left processing for a later claim call to clean up',
    v_still_processing_count = 3 - v_dead_letter_count, v_still_processing_count::text
  );

  -- A second claim call drains the rest of the bounded backlog.
  perform public.commerce_claim_order_outbox_events('worker-bounded-sweeper', 300, 2);
  select count(*) into v_dead_letter_count
  from commerce_runtime.order_outbox_events
  where account_id = '90000000-0000-4000-8000-000000000001' and id = any (v_event_ids) and status = 'dead_letter';
  perform pg_temp.expect(
    'a follow-up claim call drains the remainder of the exhausted backlog',
    v_dead_letter_count = 3, v_dead_letter_count::text
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
  v_order := public.commerce_create_order(
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
    select public.commerce_create_order(
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
      '90000000-0000-4000-8000-000000000001', 'raw-oversized-key', repeat('0', 64), 'created', 1,
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

select pg_temp.expect_rejection(
  'orders rejects a state_version below the 1-based floor (defense in depth)',
  $sql$
    insert into commerce_runtime.orders (
      account_id, idempotency_key, payload_hash, status, state_version,
      currency, total_amount_minor
    ) values (
      '90000000-0000-4000-8000-000000000001', 'raw-zero-version-key', repeat('0', 64), 'created', 0,
      'USD', 100
    )
  $sql$,
  '23514',
  'orders_state_version_check'
);

-- ---------------------------------------------------------------------------------------------
-- Closed-schema grants: no direct table/schema access for anon or authenticated, and the public
-- RPC-exposure wrappers are reachable only by service_role too — exposing a public contract must
-- not loosen the closed-schema access model underneath it.
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

  if has_function_privilege('anon', 'public.commerce_create_order(uuid, text, text, bigint, text, jsonb, text)', 'execute')
    or has_function_privilege('authenticated', 'public.commerce_create_order(uuid, text, text, bigint, text, jsonb, text)', 'execute') then
    raise exception 'TEST_FAILURE [public wrapper isolation]: browser role can execute public.commerce_create_order';
  end if;
  raise notice 'PASS [public wrapper isolation]: anon/authenticated cannot execute public.commerce_create_order';

  if not has_function_privilege('service_role', 'public.commerce_create_order(uuid, text, text, bigint, text, jsonb, text)', 'execute') then
    raise exception 'TEST_FAILURE [public wrapper contract]: service_role cannot execute public.commerce_create_order';
  end if;
  raise notice 'PASS [public wrapper contract]: service_role can execute public.commerce_create_order';
end;
$$;

rollback;
