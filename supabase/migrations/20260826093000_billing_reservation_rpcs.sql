-- ADR 003: billing.* reservation RPCs — fail-closed admission, FEFO allocation, fenced lifecycle.

create function billing.reserve_usage(
  p_account_id uuid,
  p_idempotency_key text,
  p_units bigint,
  p_owner_token text,
  p_ttl_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_control runtime.system_controls%rowtype;
  v_cutover billing.cutover_state%rowtype;
  v_legacy public.token_usage_reservations%rowtype;
  v_existing billing.usage_reservations%rowtype;
  v_policy billing.account_usage_policies%rowtype;
  v_matrix billing.pricing_matrices%rowtype;
  v_outstanding bigint;
  v_bucket record;
  v_remaining_needed bigint;
  v_take bigint;
  v_reservation_id uuid := gen_random_uuid();
  v_claim_token uuid := gen_random_uuid();
  v_now timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_allocations jsonb := '[]'::jsonb;
  v_bucket_ids uuid[] := '{}';
  v_alloc_units bigint[] := '{}';
  v_result jsonb;
begin
  if p_account_id is null then
    raise exception using errcode = '22023', message = 'invalid account id';
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid idempotency key';
  end if;
  if p_units is null or p_units <= 0 then
    raise exception using errcode = '22023', message = 'invalid reservation units';
  end if;
  if p_owner_token is null or char_length(p_owner_token) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid owner token';
  end if;
  if p_ttl_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid reservation ttl';
  end if;

  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then
    return jsonb_build_object('status', 'denied_kill_switch');
  end if;

  -- Global cutover gate (ADR 003 §5): v2 admits nothing until billing.activate_global_cutover has
  -- run. This is the mirror image of the cutover check patched into public.reserve_token_usage, so
  -- exactly one of the two routes ever admits for a given moment in time.
  select cutover.* into strict v_cutover
  from billing.cutover_state as cutover
  where cutover.singleton
  for share;
  if not v_cutover.v2_active then
    return jsonb_build_object('status', 'denied_cutover_inactive');
  end if;

  -- Lock this account's policy row FIRST, before the idempotency lookup and the outstanding-budget
  -- calculation, so that all concurrent reserve_usage calls for the same account serialize on this
  -- one lock. That serialization is what makes the idempotency lookup below race-free (a concurrent
  -- caller with the same idempotency_key can no longer race the INSERT — it queues behind this lock
  -- and then sees the first caller's committed row) and what makes the budget check exact (no two
  -- concurrent callers can read the same "outstanding" total and both admit past budget_units).
  select policy.* into v_policy
  from billing.account_usage_policies as policy
  where policy.account_id = p_account_id
  for update;
  if not found then
    return jsonb_build_object('status', 'denied_no_policy');
  end if;

  -- Cross-scheme idempotency at cutover (ADR 003 §5): p_idempotency_key and the legacy
  -- public.token_usage_reservations.billing_key share the same caller-chosen key space, so a
  -- legacy reservation finalized before cutover and retried with the same key after cutover must
  -- not be silently re-admitted and re-charged by v2. The policy lock above already serializes
  -- same-account callers, so this lookup is race-free against a concurrent legacy writer too.
  select legacy.* into v_legacy
  from public.token_usage_reservations as legacy
  where legacy.account_id = p_account_id and legacy.billing_key = p_idempotency_key
  for update;
  if found then
    if v_legacy.status = 'finalized' then
      return jsonb_build_object(
        'status', 'legacy_finalized',
        'idempotent_replay', true,
        'legacy_result', v_legacy.result
      );
    elsif v_legacy.status = 'active' then
      -- An active legacy reservation after cutover means the legacy admission route raced (or was
      -- bypassed) past the point where it should have been denied by the cutover gate. Fail closed
      -- rather than risk double-admitting the same logical work.
      return jsonb_build_object('status', 'denied_legacy_active');
    end if;
    -- released/expired: the legacy reservation consumed no lasting balance (it was refunded or
    -- swept without ever finalizing), so admitting a fresh v2 reservation under the same key is
    -- correct — fall through to the v2 idempotency lookup below.
  end if;

  -- Tenant-scoped idempotency: any prior result for this key wins, regardless of its status. Safe
  -- from unique_violation races now because the policy lock above already serializes same-account
  -- callers — a second call with the same key can only reach this SELECT after the first call's
  -- INSERT has committed (or the first call is still holding the policy lock ahead of it).
  select reservation.* into v_existing
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id
    and reservation.idempotency_key = p_idempotency_key
  for update;
  if found then
    return jsonb_build_object(
      'status', case v_existing.status
        when 'reserved' then 'reserved'
        else v_existing.status
      end,
      'reservation_id', v_existing.id,
      'claim_token', v_existing.claim_token,
      'lease_epoch', v_existing.lease_epoch,
      'reserved_units', v_existing.reserved_units,
      'expires_at', v_existing.expires_at,
      'idempotent_replay', true
    );
  end if;

  select matrix.* into strict v_matrix
  from billing.pricing_matrices as matrix
  where matrix.version = v_policy.pricing_matrix_version;

  select coalesce(sum(reservation.reserved_units), 0) into v_outstanding
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id
    and reservation.status = 'reserved'
    and reservation.expires_at > v_now;

  if v_outstanding + p_units > v_policy.budget_units then
    return jsonb_build_object(
      'status', 'denied_budget',
      'outstanding_units', v_outstanding,
      'budget_units', v_policy.budget_units
    );
  end if;

  v_remaining_needed := p_units;
  v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  -- FEFO, locked (not skip locked): a scarce bucket must serialize concurrent reservers so that
  -- exactly as many admissions succeed as there are units, deterministically. See ADR 003 §4.1.
  for v_bucket in
    select bucket.id, bucket.remaining_units
    from billing.usage_buckets as bucket
    where bucket.account_id = p_account_id
      and bucket.remaining_units > 0
      and bucket.expires_at > v_now
    order by bucket.expires_at asc, bucket.id asc
    for update
  loop
    exit when v_remaining_needed <= 0;
    v_take := least(v_bucket.remaining_units, v_remaining_needed);
    v_bucket_ids := v_bucket_ids || v_bucket.id;
    v_alloc_units := v_alloc_units || v_take;
    v_remaining_needed := v_remaining_needed - v_take;
  end loop;

  if v_remaining_needed > 0 then
    return jsonb_build_object(
      'status', 'denied_insufficient_units',
      'requested_units', p_units,
      'short_by', v_remaining_needed
    );
  end if;

  insert into billing.usage_reservations (
    id, account_id, idempotency_key, claim_token, lease_epoch, owner_token,
    status, reserved_units, policy_snapshot, expires_at
  ) values (
    v_reservation_id, p_account_id, p_idempotency_key, v_claim_token, 0, p_owner_token,
    'reserved', p_units,
    jsonb_build_object(
      'pricing_matrix_version', v_matrix.version,
      'budget_units', v_policy.budget_units,
      'conversion_rules', v_matrix.conversion_rules
    ),
    v_expires_at
  );

  update billing.usage_buckets as bucket
  set remaining_units = bucket.remaining_units - alloc.units
  from (
    select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units
  ) as alloc
  where bucket.account_id = p_account_id and bucket.id = alloc.id;

  insert into billing.usage_reservation_allocations (account_id, reservation_id, bucket_id, allocated_units)
  select p_account_id, v_reservation_id, alloc.id, alloc.units
  from (
    select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units
  ) as alloc;

  insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id, idempotency_key)
  select p_account_id, 'reserve', alloc.units, v_reservation_id, alloc.id, p_idempotency_key
  from (
    select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units
  ) as alloc;

  select jsonb_agg(jsonb_build_object('bucket_id', alloc.id, 'allocated_units', alloc.units))
  into v_allocations
  from (select unnest(v_bucket_ids) as id, unnest(v_alloc_units) as units) as alloc;

  v_result := jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_reservation_id,
    'claim_token', v_claim_token,
    'lease_epoch', 0,
    'reserved_units', p_units,
    'expires_at', v_expires_at,
    'allocations', coalesce(v_allocations, '[]'::jsonb)
  );
  return v_result;
end
$$;

create function billing.heartbeat_usage(
  p_account_id uuid,
  p_reservation_id uuid,
  p_claim_token uuid,
  p_lease_epoch bigint,
  p_extend_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_extend_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid heartbeat extension';
  end if;

  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;
  if v_reservation.status <> 'reserved' or v_reservation.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'reservation not active';
  end if;
  if v_reservation.claim_token is distinct from p_claim_token
    or v_reservation.lease_epoch is distinct from p_lease_epoch then
    raise exception using errcode = '55000', message = 'reservation ownership mismatch';
  end if;

  update billing.usage_reservations
  set expires_at = v_now + pg_catalog.make_interval(secs => p_extend_seconds)
  where account_id = p_account_id and id = p_reservation_id;

  return jsonb_build_object(
    'status', 'reserved',
    'reservation_id', p_reservation_id,
    'claim_token', p_claim_token,
    'lease_epoch', p_lease_epoch,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_extend_seconds)
  );
end
$$;

create function billing.reclaim_usage_reservation(
  p_account_id uuid,
  p_reservation_id uuid,
  p_new_owner_token text,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_new_token uuid := gen_random_uuid();
  v_new_epoch bigint;
begin
  if p_new_owner_token is null or char_length(p_new_owner_token) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'invalid owner token';
  end if;
  if p_lease_seconds not between 5 and 3600 then
    raise exception using errcode = '22023', message = 'invalid reclaim lease duration';
  end if;

  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception using errcode = '55000', message = 'reservation not reclaimable';
  end if;
  if v_reservation.expires_at > v_now then
    raise exception using errcode = '55000', message = 'reservation lease has not expired';
  end if;

  v_new_epoch := v_reservation.lease_epoch + 1;
  update billing.usage_reservations
  set claim_token = v_new_token,
      lease_epoch = v_new_epoch,
      owner_token = p_new_owner_token,
      expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  where account_id = p_account_id and id = p_reservation_id;

  return jsonb_build_object(
    'status', 'reserved',
    'reservation_id', p_reservation_id,
    'claim_token', v_new_token,
    'lease_epoch', v_new_epoch,
    'expires_at', v_now + pg_catalog.make_interval(secs => p_lease_seconds)
  );
end
$$;

create function billing.finalize_usage(
  p_account_id uuid,
  p_reservation_id uuid,
  p_claim_token uuid,
  p_lease_epoch bigint,
  p_actual_units bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_refund bigint;
  v_allocated_total bigint;
  v_running_refund bigint := 0;
  v_alloc record;
  v_apply record;
  v_this_refund bigint;
  v_last_id uuid;
  v_result jsonb;
  v_calc_ids uuid[] := '{}';
  v_calc_buckets uuid[] := '{}';
  v_calc_refunds bigint[] := '{}';
begin
  if p_actual_units is null or p_actual_units < 0 then
    raise exception using errcode = '22023', message = 'invalid actual usage';
  end if;

  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_reservation.status = 'finalized' then
    return v_reservation.result;
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception using errcode = '55000', message = 'reservation not active';
  end if;
  if v_reservation.expires_at <= v_now then
    raise exception using errcode = '55000', message = 'reservation expired; reclaim required';
  end if;
  if v_reservation.claim_token is distinct from p_claim_token
    or v_reservation.lease_epoch is distinct from p_lease_epoch then
    raise exception using errcode = '55000', message = 'reservation ownership mismatch';
  end if;
  if p_actual_units > v_reservation.reserved_units then
    raise exception using errcode = '22023', message = 'actual_units exceeds reserved_units';
  end if;

  v_refund := v_reservation.reserved_units - p_actual_units;

  select coalesce(sum(allocation.allocated_units), 0) into v_allocated_total
  from billing.usage_reservation_allocations as allocation
  where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id;

  select allocation.id into v_last_id
  from billing.usage_reservation_allocations as allocation
  where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id
  order by allocation.id desc
  limit 1;

  if v_refund > 0 then
    -- Pass 1: compute the largest-remainder refund split in allocation-id order (pure arithmetic,
    -- no locks taken — this order only decides which allocation absorbs the rounding remainder).
    for v_alloc in
      select allocation.id, allocation.bucket_id, allocation.allocated_units
      from billing.usage_reservation_allocations as allocation
      where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id
      order by allocation.id asc
    loop
      if v_alloc.id = v_last_id then
        v_this_refund := v_refund - v_running_refund;
      else
        v_this_refund := (v_refund * v_alloc.allocated_units) / v_allocated_total;
      end if;
      v_running_refund := v_running_refund + v_this_refund;
      v_calc_ids := v_calc_ids || v_alloc.id;
      v_calc_buckets := v_calc_buckets || v_alloc.bucket_id;
      v_calc_refunds := v_calc_refunds || v_this_refund;
    end loop;

    -- Pass 2: apply the credits and take the bucket row locks in bucket_id-ascending order — the
    -- same global lock order used by release_usage and expire_usage_reservations below, so two
    -- concurrent settlements that happen to share buckets can never deadlock against each other
    -- (see ADR 003 §4.3/§4.4).
    for v_apply in
      select t.id, t.bucket_id, t.refund_units
      from unnest(v_calc_ids, v_calc_buckets, v_calc_refunds) as t(id, bucket_id, refund_units)
      where t.refund_units > 0
      order by t.bucket_id asc, t.id asc
    loop
      update billing.usage_reservation_allocations
      set refunded_units = refunded_units + v_apply.refund_units
      where account_id = p_account_id and id = v_apply.id;

      update billing.usage_buckets
      set remaining_units = remaining_units + v_apply.refund_units
      where account_id = p_account_id and id = v_apply.bucket_id;

      insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id)
      values (p_account_id, 'refund', v_apply.refund_units, p_reservation_id, v_apply.bucket_id);
    end loop;
  end if;

  insert into billing.usage_ledger (account_id, event_type, units, reservation_id)
  values (p_account_id, 'finalize', p_actual_units, p_reservation_id);

  v_result := jsonb_build_object(
    'status', 'finalized',
    'reservation_id', p_reservation_id,
    'reserved_units', v_reservation.reserved_units,
    'actual_units', p_actual_units,
    'refunded_units', v_refund
  );

  update billing.usage_reservations
  set status = 'finalized', actual_units = p_actual_units, result = v_result, finalized_at = v_now
  where account_id = p_account_id and id = p_reservation_id;

  return v_result;
end
$$;

create function billing.release_usage(
  p_account_id uuid,
  p_reservation_id uuid,
  p_claim_token uuid,
  p_lease_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reservation billing.usage_reservations%rowtype;
  v_now timestamptz := clock_timestamp();
  v_alloc record;
  v_result jsonb;
begin
  select reservation.* into v_reservation
  from billing.usage_reservations as reservation
  where reservation.account_id = p_account_id and reservation.id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'reservation not found';
  end if;

  if v_reservation.status in ('released', 'expired') then
    return jsonb_build_object(
      'status', v_reservation.status,
      'reservation_id', p_reservation_id,
      'refunded_units', v_reservation.reserved_units
    );
  end if;
  if v_reservation.status <> 'reserved' then
    raise exception using errcode = '55000', message = 'reservation not active';
  end if;
  if v_reservation.claim_token is distinct from p_claim_token
    or v_reservation.lease_epoch is distinct from p_lease_epoch then
    raise exception using errcode = '55000', message = 'reservation ownership mismatch';
  end if;

  -- Deterministic bucket_id-ascending lock order — matches finalize_usage's pass 2 and
  -- expire_usage_reservations below, so concurrent settlements sharing buckets never deadlock.
  for v_alloc in
    select allocation.id, allocation.bucket_id, allocation.allocated_units, allocation.refunded_units
    from billing.usage_reservation_allocations as allocation
    where allocation.account_id = p_account_id and allocation.reservation_id = p_reservation_id
    order by allocation.bucket_id asc, allocation.id asc
  loop
    update billing.usage_reservation_allocations
    set refunded_units = allocation.allocated_units
    from (select v_alloc.allocated_units as allocated_units) as allocation
    where account_id = p_account_id and id = v_alloc.id;

    update billing.usage_buckets
    set remaining_units = remaining_units + (v_alloc.allocated_units - v_alloc.refunded_units)
    where account_id = p_account_id and id = v_alloc.bucket_id;

    insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id)
    values (
      p_account_id, 'release', v_alloc.allocated_units - v_alloc.refunded_units,
      p_reservation_id, v_alloc.bucket_id
    );
  end loop;

  v_result := jsonb_build_object(
    'status', 'released',
    'reservation_id', p_reservation_id,
    'refunded_units', v_reservation.reserved_units
  );

  update billing.usage_reservations
  set status = 'released', result = v_result, released_at = v_now
  where account_id = p_account_id and id = p_reservation_id;

  return v_result;
end
$$;

create function billing.expire_usage_reservations(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_reservation record;
  v_alloc record;
  v_expired_count integer := 0;
  v_expired_units bigint := 0;
begin
  if p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'invalid expiry batch limit';
  end if;

  for v_reservation in
    select reservation.account_id, reservation.id, reservation.reserved_units
    from billing.usage_reservations as reservation
    where reservation.status = 'reserved' and reservation.expires_at <= v_now
    order by reservation.account_id, reservation.expires_at, reservation.id
    for update skip locked
    limit p_limit
  loop
    -- Deterministic bucket_id-ascending lock order — matches finalize_usage/release_usage above.
    for v_alloc in
      select allocation.id, allocation.bucket_id, allocation.allocated_units, allocation.refunded_units
      from billing.usage_reservation_allocations as allocation
      where allocation.account_id = v_reservation.account_id
        and allocation.reservation_id = v_reservation.id
      order by allocation.bucket_id asc, allocation.id asc
    loop
      update billing.usage_reservation_allocations
      set refunded_units = v_alloc.allocated_units
      where account_id = v_reservation.account_id and id = v_alloc.id;

      update billing.usage_buckets
      set remaining_units = remaining_units + (v_alloc.allocated_units - v_alloc.refunded_units)
      where account_id = v_reservation.account_id and id = v_alloc.bucket_id;

      insert into billing.usage_ledger (account_id, event_type, units, reservation_id, bucket_id)
      values (
        v_reservation.account_id, 'expire', v_alloc.allocated_units - v_alloc.refunded_units,
        v_reservation.id, v_alloc.bucket_id
      );
    end loop;

    update billing.usage_reservations
    set status = 'expired',
        result = jsonb_build_object(
          'status', 'expired', 'reservation_id', v_reservation.id,
          'refunded_units', v_reservation.reserved_units
        ),
        released_at = v_now
    where account_id = v_reservation.account_id and id = v_reservation.id;

    v_expired_count := v_expired_count + 1;
    v_expired_units := v_expired_units + v_reservation.reserved_units;
  end loop;

  return jsonb_build_object('expired_count', v_expired_count, 'expired_units', v_expired_units);
end
$$;

revoke all on function billing.reserve_usage(uuid, text, bigint, text, integer)
  from public, anon, authenticated;
revoke all on function billing.heartbeat_usage(uuid, uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function billing.reclaim_usage_reservation(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function billing.finalize_usage(uuid, uuid, uuid, bigint, bigint)
  from public, anon, authenticated;
revoke all on function billing.release_usage(uuid, uuid, uuid, bigint)
  from public, anon, authenticated;
revoke all on function billing.expire_usage_reservations(integer)
  from public, anon, authenticated;

grant execute on function billing.reserve_usage(uuid, text, bigint, text, integer) to service_role;
grant execute on function billing.heartbeat_usage(uuid, uuid, uuid, bigint, integer) to service_role;
grant execute on function billing.reclaim_usage_reservation(uuid, uuid, text, integer) to service_role;
grant execute on function billing.finalize_usage(uuid, uuid, uuid, bigint, bigint) to service_role;
grant execute on function billing.release_usage(uuid, uuid, uuid, bigint) to service_role;
grant execute on function billing.expire_usage_reservations(integer) to service_role;

comment on function billing.reserve_usage(uuid, text, bigint, text, integer) is
  'Fail-closed FEFO admission: system_controls gate, global cutover gate, per-account policy lock, tenant-idempotent.';
comment on function billing.finalize_usage(uuid, uuid, uuid, bigint, bigint) is
  'Fenced settlement: rejects actual_units > reserved_units, proportional multi-bucket refund in bucket_id lock order, idempotent retry.';
comment on function billing.release_usage(uuid, uuid, uuid, bigint) is
  'Fenced full refund in bucket_id lock order; idempotent on retry once already released or expired.';
comment on function billing.expire_usage_reservations(integer) is
  'Bounded batch sweep of overdue reservations in bucket_id lock order; skip locked is safe on the reservation scan because rows are independent.';
comment on function billing.reclaim_usage_reservation(uuid, uuid, text, integer) is
  'Increments lease_epoch to fence out a stale claim_token after lease expiry.';
