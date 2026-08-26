-- ADR 004: order service RPCs — idempotent creation, fenced FSM transitions, all-or-nothing
-- multi-SKU inventory reservation, leased Kafka outbox claim/finish, and atomic consumer-inbox
-- dedupe. commerce_runtime stays closed; every legitimate caller is service_role via these RPCs.

create function commerce_runtime.sha256_text(p_value text)
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

create function commerce_runtime.sha256_jsonb(p_value jsonb)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select commerce_runtime.sha256_text(p_value::text)
$$;

revoke all on function commerce_runtime.sha256_text(text) from public, anon, authenticated;
revoke all on function commerce_runtime.sha256_jsonb(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.create_order — atomic idempotent creation: order + birth transition + domain
-- outbox event, one transaction (ADR 004 §5.1). ON CONFLICT replay returns the existing order only
-- when the canonical payload hash of the immutable inputs matches; a mismatched hash under the same
-- idempotency key is rejected as a collision, never silently overwritten.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.create_order(
  p_account_id uuid,
  p_idempotency_key text,
  p_currency text,
  p_total_amount_minor bigint,
  p_customer_ref text default null,
  p_order_payload jsonb default '{}'::jsonb,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inserted commerce_runtime.orders%rowtype;
  v_existing commerce_runtime.orders%rowtype;
  v_canonical jsonb;
  v_hash text;
  v_order_id uuid := gen_random_uuid();
  v_birth_event_payload jsonb;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'invalid account id';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception using errcode = '22023', message = 'invalid currency code';
  end if;
  if p_total_amount_minor is null or p_total_amount_minor < 0 then
    raise exception using errcode = '22023', message = 'invalid order total';
  end if;
  if p_customer_ref is not null and char_length(p_customer_ref) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid customer reference';
  end if;
  if p_order_payload is null or jsonb_typeof(p_order_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid order payload';
  end if;
  if octet_length(p_order_payload::text) > 65536 then
    raise exception using errcode = '22023', message = 'order payload too large';
  end if;

  v_canonical := jsonb_build_object(
    'currency', p_currency,
    'total_amount_minor', p_total_amount_minor,
    'customer_ref', p_customer_ref,
    'order_payload', p_order_payload
  );
  v_hash := commerce_runtime.sha256_jsonb(v_canonical);

  -- Race-free tenant-scoped idempotency: a plain SELECT ... FOR UPDATE against a key that has no
  -- row yet takes no gap lock in Postgres, so two concurrent identical calls would both find
  -- nothing and both attempt the INSERT below, and one would lose to unique_violation. Instead we
  -- always attempt the INSERT; ON CONFLICT DO NOTHING makes it the arbiter — Postgres itself
  -- serializes concurrent inserters on the (account_id, idempotency_key) unique index and blocks a
  -- losing inserter until the winner's transaction concludes, so by the time control reaches the
  -- "did we win" check below, the winner's row (if it committed) is guaranteed visible.
  insert into commerce_runtime.orders (
    id, account_id, idempotency_key, payload_hash, status, state_version,
    currency, total_amount_minor, customer_ref, order_payload, correlation_id
  ) values (
    v_order_id, p_account_id, p_idempotency_key, v_hash, 'created', 1,
    p_currency, p_total_amount_minor, p_customer_ref, p_order_payload, p_correlation_id
  )
  on conflict (account_id, idempotency_key) do nothing
  returning * into v_inserted;

  if v_inserted.id is null then
    -- Lost the insert race (or this is a genuine later retry): the winner's row is committed and
    -- visible now, since ON CONFLICT DO NOTHING only reaches "do nothing" after waiting out any
    -- concurrent inserter racing the same conflicting key.
    select order_row.* into v_existing
    from commerce_runtime.orders as order_row
    where order_row.account_id = p_account_id and order_row.idempotency_key = p_idempotency_key;

    if v_existing.payload_hash = v_hash then
      return jsonb_build_object(
        'status', v_existing.status,
        'order_id', v_existing.id,
        'state_version', v_existing.state_version,
        'idempotent_replay', true
      );
    else
      return jsonb_build_object(
        'status', 'idempotency_key_collision',
        'order_id', v_existing.id,
        'idempotent_replay', false
      );
    end if;
  end if;

  -- We won the insert: only the winner creates the birth transition and outbox event, so a
  -- concurrent identical create_order storm produces exactly one order, one birth transition
  -- (transition_seq = 1, matching state_version = 1 the order is born at), and one outbox event.
  insert into commerce_runtime.order_transitions (
    account_id, order_id, transition_seq, from_state, to_state,
    actor_type, actor_id, correlation_id, transition_payload
  ) values (
    p_account_id, v_order_id, 1, 'new', 'created',
    'system', 'create_order', p_correlation_id, '{}'::jsonb
  );

  v_birth_event_payload := jsonb_build_object(
    'order_id', v_order_id, 'status', 'created', 'currency', p_currency,
    'total_amount_minor', p_total_amount_minor
  );

  insert into commerce_runtime.order_outbox_events (
    account_id, order_id, event_type, payload, payload_hash, dedupe_key, correlation_id
  ) values (
    p_account_id, v_order_id, 'order.created', v_birth_event_payload,
    commerce_runtime.sha256_jsonb(v_birth_event_payload),
    v_order_id::text || ':order.created',
    p_correlation_id
  );

  return jsonb_build_object(
    'status', 'created',
    'order_id', v_order_id,
    'state_version', 1,
    'idempotent_replay', false
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.transition_order — generic fenced FSM transition (ADR 004 §5.2). Illegal pairs
-- are rejected by the allowed_order_transitions composite FK, not by application logic here.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.transition_order(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order commerce_runtime.orders%rowtype;
  v_now timestamptz := clock_timestamp();
  v_new_version bigint;
  v_payload jsonb := coalesce(p_transition_payload, '{}'::jsonb);
  v_event_payload jsonb;
begin
  if p_to_state is null or char_length(p_to_state) = 0 then
    raise exception using errcode = '22023', message = 'invalid target state';
  end if;
  if p_actor_type not in ('system', 'worker', 'user', 'admin', 'maintenance') then
    raise exception using errcode = '22023', message = 'invalid actor type';
  end if;
  if p_actor_id is null or char_length(p_actor_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid actor id';
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid transition payload';
  end if;
  if octet_length(v_payload::text) > 16384 then
    raise exception using errcode = '22023', message = 'transition payload too large';
  end if;
  if p_reason_code is not null and p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid reason code';
  end if;

  select order_row.* into v_order
  from commerce_runtime.orders as order_row
  where order_row.account_id = p_account_id and order_row.id = p_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  -- Optimistic-concurrency fence: a caller acting on a version that is no longer current is a
  -- stale writer and is rejected outright, not silently applied against whatever the row now is.
  if v_order.state_version <> p_expected_state_version then
    raise exception using errcode = '55000', message = 'stale order state version';
  end if;

  v_new_version := v_order.state_version + 1;

  -- An illegal (from_state, to_state) pair fails here with 23503, before orders is ever updated.
  insert into commerce_runtime.order_transitions (
    account_id, order_id, transition_seq, from_state, to_state,
    actor_type, actor_id, correlation_id, reason_code, transition_payload
  ) values (
    p_account_id, p_order_id, v_new_version, v_order.status, p_to_state,
    p_actor_type, p_actor_id, p_correlation_id, p_reason_code, v_payload
  );

  update commerce_runtime.orders
  set status = p_to_state, state_version = v_new_version, updated_at = v_now
  where account_id = p_account_id and id = p_order_id and state_version = p_expected_state_version;

  v_event_payload := jsonb_build_object(
    'order_id', p_order_id, 'from_state', v_order.status, 'to_state', p_to_state,
    'state_version', v_new_version, 'transition_payload', v_payload
  );

  insert into commerce_runtime.order_outbox_events (
    account_id, order_id, event_type, payload, payload_hash, dedupe_key, correlation_id
  ) values (
    p_account_id, p_order_id, 'order.transitioned', v_event_payload,
    commerce_runtime.sha256_jsonb(v_event_payload),
    p_order_id::text || ':' || p_to_state || ':' || v_new_version::text,
    p_correlation_id
  );

  return jsonb_build_object(
    'status', 'transitioned',
    'order_id', p_order_id,
    'from_state', v_order.status,
    'to_state', p_to_state,
    'state_version', v_new_version
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.reserve_inventory — all-or-nothing multi-SKU reservation (ADR 004 §5.3):
-- validates input, aggregates duplicate product ids, locks every existing requested inventory row
-- in deterministic product_id order (no unlocked pre-check), verifies every locked line has stock
-- before mutating any of them, then reuses transition_order for the created -> inventory_reserved
-- transition on success, or created -> inventory_rejected on missing/insufficient stock, within the
-- same transaction either way.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.reserve_inventory(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_items jsonb,
  p_actor_type text default 'system',
  p_actor_id text default 'reserve_inventory',
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order commerce_runtime.orders%rowtype;
  v_item jsonb;
  v_product_id uuid;
  v_quantity bigint;
  v_agg_ids uuid[] := array[]::uuid[];
  v_agg_qty bigint[] := array[]::bigint[];
  v_locked_ids uuid[] := array[]::uuid[];
  v_missing uuid[] := array[]::uuid[];
  v_short jsonb := '[]'::jsonb;
  v_idx int;
  v_row record;
  v_transition_result jsonb;
  v_reason_code text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'invalid reservation items';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception using errcode = '22023', message = 'too many reservation line items';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) as elems(value)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'product_id') or not (v_item ? 'quantity') then
      raise exception using errcode = '22023', message = 'invalid reservation item shape';
    end if;

    begin
      v_product_id := (v_item ->> 'product_id')::uuid;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid reservation product id';
    end;

    begin
      v_quantity := (v_item ->> 'quantity')::bigint;
    exception when others then
      raise exception using errcode = '22023', message = 'invalid reservation quantity';
    end;

    if v_quantity <= 0 then
      raise exception using errcode = '22023', message = 'reservation quantity must be positive';
    end if;

    -- Aggregate duplicate product ids: a caller listing the same SKU twice must not bypass the
    -- stock check by splitting one oversized request into two smaller-looking ones.
    v_idx := array_position(v_agg_ids, v_product_id);
    if v_idx is null then
      v_agg_ids := v_agg_ids || v_product_id;
      v_agg_qty := v_agg_qty || v_quantity;
    else
      v_agg_qty[v_idx] := v_agg_qty[v_idx] + v_quantity;
    end if;
  end loop;

  select order_row.* into v_order
  from commerce_runtime.orders as order_row
  where order_row.account_id = p_account_id and order_row.id = p_order_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'order not found';
  end if;
  if v_order.state_version <> p_expected_state_version then
    raise exception using errcode = '55000', message = 'stale order state version';
  end if;
  if v_order.status <> 'created' then
    raise exception using errcode = '55000', message = 'order not in a reservable state';
  end if;

  -- Deterministic product_id-ascending lock order: two reservations sharing SKUs can never
  -- deadlock against each other. Locks every EXISTING requested row first (no unlocked pre-check —
  -- a pre-check-then-lock split leaves a window where a concurrent delete between the check and
  -- the lock would make a since-deleted row look present), then determines which requested ids were
  -- never locked (missing) only after the lock loop completes, and verifies every locked line's
  -- stock before mutating any of them (all-or-nothing).
  for v_row in
    select inv.product_id, inv.available
    from commerce_runtime.inventory as inv
    where inv.account_id = p_account_id and inv.product_id = any (v_agg_ids)
    order by inv.product_id asc
    for update
  loop
    v_locked_ids := v_locked_ids || v_row.product_id;
    v_idx := array_position(v_agg_ids, v_row.product_id);
    if v_row.available < v_agg_qty[v_idx] then
      v_short := v_short || jsonb_build_object(
        'product_id', v_row.product_id, 'requested', v_agg_qty[v_idx], 'available', v_row.available
      );
    end if;
  end loop;

  select array_agg(id) into v_missing
  from unnest(v_agg_ids) as id
  where not (id = any (v_locked_ids));

  if array_length(v_missing, 1) > 0 or jsonb_array_length(v_short) > 0 then
    -- Denied reservations do not leave the order sitting in created: they atomically transition it
    -- to inventory_rejected and emit that transition's outbox event, in the same transaction, so a
    -- caller and any downstream consumer both observe a definite terminal-branch outcome rather than
    -- an order that looks merely "not yet reserved" (ADR 004 §5.3).
    v_reason_code := case
      when array_length(v_missing, 1) > 0 then 'INVENTORY_MISSING_ROW'
      else 'INSUFFICIENT_STOCK'
    end;

    select commerce_runtime.transition_order(
      p_account_id, p_order_id, p_expected_state_version, 'inventory_rejected',
      p_actor_type, p_actor_id, p_correlation_id,
      jsonb_build_object(
        'missing_product_ids', to_jsonb(coalesce(v_missing, array[]::uuid[])),
        'short', v_short
      ),
      v_reason_code
    ) into v_transition_result;

    return v_transition_result
      || jsonb_build_object(
        'status', 'inventory_rejected',
        'missing_product_ids', to_jsonb(coalesce(v_missing, array[]::uuid[])),
        'short', v_short
      );
  end if;

  update commerce_runtime.inventory as inv
  set available = inv.available - alloc.qty,
      reserved = inv.reserved + alloc.qty,
      version = inv.version + 1,
      updated_at = clock_timestamp()
  from (
    select unnest(v_agg_ids) as product_id, unnest(v_agg_qty) as qty
  ) as alloc
  where inv.account_id = p_account_id and inv.product_id = alloc.product_id;

  select commerce_runtime.transition_order(
    p_account_id, p_order_id, p_expected_state_version, 'inventory_reserved',
    p_actor_type, p_actor_id, p_correlation_id,
    jsonb_build_object(
      'reserved_items', (
        select jsonb_agg(jsonb_build_object('product_id', pid, 'quantity', qty))
        from unnest(v_agg_ids, v_agg_qty) as t(pid, qty)
      )
    ),
    null
  ) into v_transition_result;

  return v_transition_result
    || jsonb_build_object('reserved_item_count', array_length(v_agg_ids, 1));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.claim_order_outbox_events / finish_order_outbox_event — leased Kafka publish
-- claim (ADR 004 §5.4). Claim never holds a lock while a worker talks to Kafka: it returns the
-- claimed batch and the worker publishes and reports back via finish in a separate transaction.
--
-- Claim is a single atomic CTE (SELECT ... FOR UPDATE SKIP LOCKED feeding an UPDATE ... FROM), not
-- a per-row PL/pgSQL loop, so the candidate scan and the claim mutation are one statement. It also
-- self-heals a lease that expired on an event's FINAL attempt: such a row previously matched
-- neither the claimable-candidate predicate (attempt_count < max_attempts excludes it) nor any
-- sweep job, so it stayed 'processing' with a dead lease forever. Claim now dead-letters those rows
-- itself, in the same statement, every time it runs — but only up to p_limit of them per call
-- (exhausted_candidates is its own bounded, deterministically-ordered, FOR UPDATE SKIP LOCKED scan),
-- so a large outage backlog of exhausted leases cannot turn one claim call into an unbounded
-- transaction that every concurrent claimer then contends on.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.claim_order_outbox_events(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 20
)
returns table (
  account_id uuid,
  outbox_event_id uuid,
  order_id uuid,
  event_type text,
  event_version text,
  schema_version text,
  payload jsonb,
  dedupe_key text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_lease_duration_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid outbox lease duration';
  end if;
  if p_limit not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid outbox claim limit';
  end if;

  return query
  with exhausted_candidates as (
    -- Bounded scan for exhausted, expired processing rows: same lease-exhaustion predicate the
    -- dead-lettering below relies on, but capped to p_limit rows in deterministic order under
    -- FOR UPDATE SKIP LOCKED, so a large outage backlog dead-letters at most p_limit rows per claim
    -- call instead of every exhausted row in the table in one unbounded transaction.
    select event.account_id, event.id
    from commerce_runtime.order_outbox_events as event
    where event.status = 'processing'
      and event.lease_until <= clock_timestamp()
      and event.attempt_count >= event.max_attempts
    order by event.lease_until, event.created_at, event.id
    for update skip locked
    limit p_limit
  ),
  dead_lettered as (
    -- Self-heal: an event whose lease expired on its last attempt is exhausted and unreclaimable
    -- by the candidates CTE below (attempt_count < max_attempts excludes it) — without this it
    -- would stay 'processing' with a dead lease forever. Dead-letter it here instead, clearing the
    -- lease so it stops looking like a live claim. Scoped to exhausted_candidates above, so this
    -- UPDATE only ever touches the bounded set just locked, never the full exhausted backlog.
    update commerce_runtime.order_outbox_events as event
    set status = 'dead_letter',
        claim_token = null,
        lease_holder = null,
        lease_until = null,
        next_attempt_at = null,
        last_error_code = 'LEASE_EXHAUSTED',
        sanitized_error_message = 'Outbox lease expired after exhausting max_attempts',
        updated_at = clock_timestamp()
    from exhausted_candidates
    where event.account_id = exhausted_candidates.account_id and event.id = exhausted_candidates.id
    returning event.id
  ),
  candidates as (
    -- Never-claimed pending rows, retry_scheduled rows past their backoff, and processing rows
    -- whose lease already expired but still have attempts left (an abandoned lease is reclaimable
    -- here, no separate sweep job needed).
    select event.account_id, event.id
    from commerce_runtime.order_outbox_events as event
    where event.attempt_count < event.max_attempts
      and event.id <> all (array(select dead_lettered.id from dead_lettered))
      and (
        event.status = 'pending'
        or (event.status = 'retry_scheduled' and event.next_attempt_at <= clock_timestamp())
        or (event.status = 'processing' and event.lease_until <= clock_timestamp())
      )
    order by coalesce(event.next_attempt_at, event.created_at), event.created_at, event.id
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update commerce_runtime.order_outbox_events as event
    set status = 'processing',
        claim_token = gen_random_uuid(),
        lease_holder = p_worker_id,
        lease_until = clock_timestamp() + pg_catalog.make_interval(secs => p_lease_duration_seconds),
        lease_epoch = event.lease_epoch + 1,
        attempt_count = event.attempt_count + 1,
        next_attempt_at = null,
        updated_at = clock_timestamp()
    from candidates
    where event.account_id = candidates.account_id and event.id = candidates.id
    returning event.account_id, event.id as outbox_event_id, event.order_id, event.event_type,
      event.event_version, event.schema_version, event.payload, event.dedupe_key,
      event.claim_token, event.lease_epoch, event.lease_until, event.attempt_count
  )
  select account_id, outbox_event_id, order_id, event_type, event_version, schema_version,
    payload, dedupe_key, claim_token, lease_epoch, lease_until, attempt_count
  from claimed;
end
$$;

create function commerce_runtime.finish_order_outbox_event(
  p_account_id uuid,
  p_outbox_event_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_result_status text,
  p_worker_id text,
  p_next_attempt_at timestamptz default null,
  p_error_code text default null,
  p_sanitized_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event commerce_runtime.order_outbox_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text := p_result_status;
  v_next_attempt_at timestamptz := p_next_attempt_at;
begin
  -- 'failed' is not a status the order_outbox_events_status_check CHECK constraint permits — the
  -- table's explicit lifecycle is pending/processing/retry_scheduled/published/dead_letter, and a
  -- worker-observed publish failure is always translated by the caller into either
  -- 'retry_scheduled' (more attempts left) or 'dead_letter' (attempt budget exhausted), never a
  -- bare 'failed' the table itself would reject.
  if p_result_status not in ('published', 'retry_scheduled', 'dead_letter') then
    raise exception using errcode = '22023', message = 'invalid outbox result status';
  end if;
  if p_worker_id is null or char_length(p_worker_id) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid outbox worker id';
  end if;
  if p_result_status in ('retry_scheduled', 'dead_letter') and p_error_code is null then
    raise exception using errcode = '22023', message = 'outbox retry/dead-letter requires error code';
  end if;

  select event.* into v_event
  from commerce_runtime.order_outbox_events as event
  where event.account_id = p_account_id and event.id = p_outbox_event_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'outbox event not found';
  end if;

  -- Fencing: a worker whose lease already expired (and was reclaimed by another worker) is
  -- rejected even if it eventually calls finish, so two workers can never both believe they
  -- published the same event. p_worker_id must also match the current lease_holder, not just the
  -- token/epoch/expiry — a worker id mismatch under an otherwise-valid token would mean a worker
  -- is reporting on a lease it never actually held.
  if v_event.status <> 'processing'
    or v_event.lease_epoch <> p_expected_epoch
    or v_event.claim_token is distinct from p_claim_token
    or v_event.lease_holder <> p_worker_id
    or v_event.lease_until <= v_now then
    raise exception using errcode = '55000', message = 'stale or invalid outbox lease';
  end if;

  if v_status = 'retry_scheduled' then
    -- Bounded exponential backoff regardless of caller input; once the attempt budget is
    -- exhausted this is silently upgraded to dead_letter instead of retrying forever.
    if v_event.attempt_count >= v_event.max_attempts then
      v_status := 'dead_letter';
      v_next_attempt_at := null;
    else
      if v_next_attempt_at is null then
        v_next_attempt_at := v_now + pg_catalog.make_interval(
          secs => least(3600.0, power(2::double precision, v_event.attempt_count::double precision))::int
        );
      end if;
      if v_next_attempt_at < v_now then
        v_next_attempt_at := v_now;
      end if;
      if v_next_attempt_at > v_now + interval '24 hours' then
        v_next_attempt_at := v_now + interval '24 hours';
      end if;
    end if;
  else
    v_next_attempt_at := null;
  end if;

  update commerce_runtime.order_outbox_events as event
  set status = v_status,
      next_attempt_at = v_next_attempt_at,
      claim_token = null,
      lease_holder = null,
      lease_until = null,
      published_at = case when v_status = 'published' then v_now else null end,
      last_error_code = p_error_code,
      sanitized_error_message = p_sanitized_error_message,
      updated_at = v_now
  where event.account_id = p_account_id and event.id = p_outbox_event_id;

  return jsonb_build_object(
    'status', v_status,
    'outbox_event_id', p_outbox_event_id,
    'next_attempt_at', v_next_attempt_at
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.consume_order_event — atomic consumer-side inbox dedupe + business mutation
-- (ADR 004 §5.5). Dedupe insert and the resulting transition run in the same transaction: a
-- conflict short-circuits with no mutation, and a mutation failure rolls back the dedupe insert
-- too, so a message is only ever marked consumed once its effect actually committed. This does
-- not and cannot claim exactly-once delivery — only exactly-once effect application per delivery.
-- ---------------------------------------------------------------------------------------------

create function commerce_runtime.consume_order_event(
  p_account_id uuid,
  p_source_topic text,
  p_external_message_id text,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_inbox_id uuid;
  v_result jsonb;
begin
  if p_source_topic is null or char_length(p_source_topic) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid source topic';
  end if;
  if p_external_message_id is null or char_length(p_external_message_id) not between 1 and 512 then
    raise exception using errcode = '22023', message = 'invalid external message id';
  end if;

  v_hash := commerce_runtime.sha256_text(p_external_message_id);

  insert into commerce_runtime.consumer_inbox (
    account_id, source_topic, external_message_id, external_message_id_hash,
    order_id, correlation_id
  ) values (
    p_account_id, p_source_topic, p_external_message_id, v_hash,
    p_order_id, p_correlation_id
  )
  on conflict (account_id, source_topic, external_message_id_hash) do nothing
  returning id into v_inbox_id;

  if v_inbox_id is null then
    return jsonb_build_object(
      'status', 'duplicate_ignored', 'order_id', p_order_id, 'idempotent_replay', true
    );
  end if;

  select commerce_runtime.transition_order(
    p_account_id, p_order_id, p_expected_state_version, p_to_state,
    p_actor_type, p_actor_id, p_correlation_id, p_transition_payload, p_reason_code
  ) into v_result;

  return v_result;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: service_role only, everywhere.
-- ---------------------------------------------------------------------------------------------

revoke all on function commerce_runtime.create_order(
  uuid, text, text, bigint, text, jsonb, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.claim_order_outbox_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function commerce_runtime.finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function commerce_runtime.consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function commerce_runtime.create_order(
  uuid, text, text, bigint, text, jsonb, text
) to service_role;
grant execute on function commerce_runtime.transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;
grant execute on function commerce_runtime.reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) to service_role;
grant execute on function commerce_runtime.claim_order_outbox_events(text, integer, integer)
  to service_role;
grant execute on function commerce_runtime.finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) to service_role;
grant execute on function commerce_runtime.consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;

comment on function commerce_runtime.create_order(uuid, text, text, bigint, text, jsonb, text) is
  'Atomic idempotent order creation: order + birth transition + domain outbox event in one transaction.';
comment on function commerce_runtime.transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) is 'Fenced FSM transition: expected state_version, FK-enforced transition legality, outbox event.';
comment on function commerce_runtime.reserve_inventory(uuid, uuid, bigint, jsonb, text, text, text) is
  'All-or-nothing multi-SKU reservation: deterministic lock order, then created -> inventory_reserved '
  'on success or created -> inventory_rejected on missing/insufficient stock.';
comment on function commerce_runtime.claim_order_outbox_events(text, integer, integer) is
  'Single atomic CTE claim (SKIP LOCKED + UPDATE ... FROM), self-dead-lettering exhausted expired leases.';
comment on function commerce_runtime.finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) is 'Fenced settlement: claim_token + lease_epoch + unexpired lease required; bounded backoff, auto dead-letter.';
comment on function commerce_runtime.consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) is 'Atomic consumer-inbox dedupe + FSM mutation; no exactly-once delivery claim, only effect application.';

-- ---------------------------------------------------------------------------------------------
-- public.commerce_* — stable RPC-exposure wrappers (ADR 004 §5.6). Supabase/PostgREST only exposes
-- the schemas named in the project's `db.schemas` config, which is `public` (and `graphql_public`)
-- by default and does not include `commerce_runtime`; a function that exists only in
-- `commerce_runtime`, however carefully it is written, is unreachable through a normal
-- `supabase.rpc(...)` call or any other PostgREST client. These wrappers are thin pass-throughs —
-- same argument shapes, no added logic — that live in `public` purely so the closed schema's RPCs
-- have a callable public contract. Each is `security definer` with `set search_path = ''` exactly
-- like its `commerce_runtime` counterpart, and is revoked from `public`/`anon`/`authenticated` and
-- granted only to `service_role`, so exposure through PostgREST does not loosen the closed-schema
-- access model: only service_role callers (server-side, e.g. an Edge Function) can invoke either
-- the wrapper or the function it wraps.
-- ---------------------------------------------------------------------------------------------

create function public.commerce_create_order(
  p_account_id uuid,
  p_idempotency_key text,
  p_currency text,
  p_total_amount_minor bigint,
  p_customer_ref text default null,
  p_order_payload jsonb default '{}'::jsonb,
  p_correlation_id text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.create_order(
    p_account_id, p_idempotency_key, p_currency, p_total_amount_minor,
    p_customer_ref, p_order_payload, p_correlation_id
  )
$$;

create function public.commerce_transition_order(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.transition_order(
    p_account_id, p_order_id, p_expected_state_version, p_to_state,
    p_actor_type, p_actor_id, p_correlation_id, p_transition_payload, p_reason_code
  )
$$;

create function public.commerce_reserve_inventory(
  p_account_id uuid,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_items jsonb,
  p_actor_type text default 'system',
  p_actor_id text default 'reserve_inventory',
  p_correlation_id text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.reserve_inventory(
    p_account_id, p_order_id, p_expected_state_version, p_items,
    p_actor_type, p_actor_id, p_correlation_id
  )
$$;

create function public.commerce_claim_order_outbox_events(
  p_worker_id text,
  p_lease_duration_seconds integer default 300,
  p_limit integer default 20
)
returns table (
  account_id uuid,
  outbox_event_id uuid,
  order_id uuid,
  event_type text,
  event_version text,
  schema_version text,
  payload jsonb,
  dedupe_key text,
  claim_token uuid,
  lease_epoch bigint,
  lease_until timestamptz,
  attempt_count integer
)
language sql
security definer
set search_path = ''
as $$
  select * from commerce_runtime.claim_order_outbox_events(
    p_worker_id, p_lease_duration_seconds, p_limit
  )
$$;

create function public.commerce_finish_order_outbox_event(
  p_account_id uuid,
  p_outbox_event_id uuid,
  p_expected_epoch bigint,
  p_claim_token uuid,
  p_result_status text,
  p_worker_id text,
  p_next_attempt_at timestamptz default null,
  p_error_code text default null,
  p_sanitized_error_message text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.finish_order_outbox_event(
    p_account_id, p_outbox_event_id, p_expected_epoch, p_claim_token, p_result_status,
    p_worker_id, p_next_attempt_at, p_error_code, p_sanitized_error_message
  )
$$;

create function public.commerce_consume_order_event(
  p_account_id uuid,
  p_source_topic text,
  p_external_message_id text,
  p_order_id uuid,
  p_expected_state_version bigint,
  p_to_state text,
  p_actor_type text,
  p_actor_id text,
  p_correlation_id text default null,
  p_transition_payload jsonb default '{}'::jsonb,
  p_reason_code text default null
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select commerce_runtime.consume_order_event(
    p_account_id, p_source_topic, p_external_message_id, p_order_id, p_expected_state_version,
    p_to_state, p_actor_type, p_actor_id, p_correlation_id, p_transition_payload, p_reason_code
  )
$$;

revoke all on function public.commerce_create_order(
  uuid, text, text, bigint, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.commerce_transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;
revoke all on function public.commerce_reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) from public, anon, authenticated;
revoke all on function public.commerce_claim_order_outbox_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.commerce_finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.commerce_consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) from public, anon, authenticated;

grant execute on function public.commerce_create_order(
  uuid, text, text, bigint, text, jsonb, text
) to service_role;
grant execute on function public.commerce_transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;
grant execute on function public.commerce_reserve_inventory(
  uuid, uuid, bigint, jsonb, text, text, text
) to service_role;
grant execute on function public.commerce_claim_order_outbox_events(text, integer, integer)
  to service_role;
grant execute on function public.commerce_finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) to service_role;
grant execute on function public.commerce_consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) to service_role;

comment on function public.commerce_create_order(uuid, text, text, bigint, text, jsonb, text) is
  'Public RPC-exposure wrapper for commerce_runtime.create_order (service_role only).';
comment on function public.commerce_transition_order(
  uuid, uuid, bigint, text, text, text, text, jsonb, text
) is 'Public RPC-exposure wrapper for commerce_runtime.transition_order (service_role only).';
comment on function public.commerce_reserve_inventory(uuid, uuid, bigint, jsonb, text, text, text) is
  'Public RPC-exposure wrapper for commerce_runtime.reserve_inventory (service_role only).';
comment on function public.commerce_claim_order_outbox_events(text, integer, integer) is
  'Public RPC-exposure wrapper for commerce_runtime.claim_order_outbox_events (service_role only).';
comment on function public.commerce_finish_order_outbox_event(
  uuid, uuid, bigint, uuid, text, text, timestamptz, text, text
) is 'Public RPC-exposure wrapper for commerce_runtime.finish_order_outbox_event (service_role only).';
comment on function public.commerce_consume_order_event(
  uuid, text, text, uuid, bigint, text, text, text, text, jsonb, text
) is 'Public RPC-exposure wrapper for commerce_runtime.consume_order_event (service_role only).';
