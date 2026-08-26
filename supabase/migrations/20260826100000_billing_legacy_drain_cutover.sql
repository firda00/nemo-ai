-- ADR 003: GLOBAL drain-first legacy cutover. billing_legacy schema, one-way whole-environment
-- snapshot gated by runtime.system_controls maintenance + billing_legacy.quad_zero_check, a
-- fail-closed patch of the legacy admission function, atomic maintenance enter/resume, quad-zero
-- check. No per-account cutover path exists: billing.cutover_state (see the schema migration) is
-- a single singleton row, and exactly one of the legacy/v2 admission routes may admit at a time
-- for the whole environment.

create schema billing_legacy;
revoke all on schema billing_legacy from public, anon, authenticated;
grant usage on schema billing_legacy to service_role;

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.drain_snapshots — one row per account, written once by billing.activate_global_
-- cutover inside its single snapshot transaction. Composite FK to billing.usage_buckets scoped by
-- account_id makes a cross-tenant bucket reference structurally impossible; zero-unit accounts get
-- a NULL granted_bucket_id (MATCH SIMPLE lets a NULL column skip FK enforcement).
-- ---------------------------------------------------------------------------------------------

create table billing_legacy.drain_snapshots (
  account_id uuid primary key references public.accounts (id) on delete cascade,
  snapshotted_balance bigint not null,
  granted_bucket_id uuid,
  pricing_matrix_version integer references billing.pricing_matrices (version),
  snapshotted_at timestamptz not null default clock_timestamp(),
  constraint drain_snapshots_balance_check check (snapshotted_balance >= 0),
  constraint drain_snapshots_bucket_fkey
    foreign key (account_id, granted_bucket_id)
    references billing.usage_buckets (account_id, id) on delete restrict
);

revoke all on billing_legacy.drain_snapshots from public, anon, authenticated;

comment on table billing_legacy.drain_snapshots is
  'One-way per-account snapshot row written once, in bulk, by billing.activate_global_cutover.';

-- ---------------------------------------------------------------------------------------------
-- Patch the legacy admission function: add the runtime.system_controls fail-closed check used by
-- public.runtime_claim_workflow, AND the global cutover gate — once billing.cutover_state.v2_active
-- is true, legacy denies unconditionally so the two admission routes can never both admit the same
-- unit of work. Identical signature otherwise, so every existing caller keeps working.
-- finalize_token_usage/release_token_usage are untouched — in-flight legacy reservations created
-- before cutover must still be settleable.
-- ---------------------------------------------------------------------------------------------

create or replace function public.reserve_token_usage(
  p_account_id uuid,
  p_billing_key text,
  p_reserved_tokens bigint,
  p_monthly_limit bigint,
  p_run_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.token_usage_reservations;
  balance bigint;
  credits bigint;
  expired_credits bigint;
  used_tokens bigint;
  active_tokens bigint;
  month_start timestamptz := date_trunc('month', now() at time zone 'UTC') at time zone 'UTC';
  v_control runtime.system_controls%rowtype;
  v_cutover billing.cutover_state%rowtype;
begin
  if p_account_id is null or p_billing_key is null or length(p_billing_key) not between 1 and 200
    or p_reserved_tokens <= 0 or p_monthly_limit <= 0 then raise exception 'invalid reservation input'; end if;

  -- Fail-closed admission gate, matching public.runtime_claim_workflow (ADR 001/003). Returned as
  -- a denied status, not an exception, to preserve this function's existing denied_* contract.
  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for share;
  if v_control.kill_switch_active or v_control.claims_paused then
    return jsonb_build_object('status', 'denied_kill_switch');
  end if;

  -- Global cutover gate: once billing.activate_global_cutover has run, legacy denies
  -- unconditionally. Mirror of the v2_active check in billing.reserve_usage — see ADR 003 §5.
  select cutover.* into strict v_cutover
  from billing.cutover_state as cutover
  where cutover.singleton
  for share;
  if v_cutover.v2_active then
    return jsonb_build_object('status', 'denied_cutover_active');
  end if;

  perform 1 from public.autonomous_run_checkpoints where id = p_run_id and account_id = p_account_id and status = 'running' and claim_token = p_claim_token for update;
  if not found then raise exception 'worker claim lost'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  select token_balance into balance from public.accounts where id = p_account_id for update;
  if not found then raise exception 'account not found'; end if;

  select * into existing from public.token_usage_reservations
  where account_id = p_account_id and billing_key = p_billing_key;
  if found and existing.status = 'finalized' then
    return jsonb_build_object('status', existing.status, 'result', existing.result);
  end if;
  if found and existing.status = 'active' and existing.expires_at > now() then
    return jsonb_build_object('status', 'in_progress');
  end if;

  with released as (
    update public.token_usage_reservations
    set status = 'expired'
    where account_id = p_account_id and status = 'active' and expires_at <= now()
    returning reserved_credits
  ) select coalesce(sum(reserved_credits), 0) into expired_credits from released;
  balance := balance + expired_credits;
  if expired_credits > 0 then update public.accounts set token_balance = balance where id = p_account_id; end if;

  credits := ceil(p_reserved_tokens / 1000.0)::bigint;
  select coalesce(sum(tokens), 0) into used_tokens from public.usage
  where account_id = p_account_id and created_at >= month_start;
  select coalesce(sum(reserved_tokens), 0) into active_tokens from public.token_usage_reservations
  where account_id = p_account_id and status = 'active';

  if balance < credits then return jsonb_build_object('status', 'denied_balance'); end if;
  if used_tokens + active_tokens + p_reserved_tokens > p_monthly_limit then return jsonb_build_object('status', 'denied_quota'); end if;

  insert into public.token_usage_reservations(account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, expires_at)
  values (p_account_id, p_billing_key, p_run_id, p_claim_token, p_reserved_tokens, credits, p_monthly_limit, now() + interval '10 minutes')
  on conflict (account_id, billing_key) do update
    set reserved_tokens = excluded.reserved_tokens,
        reserved_credits = excluded.reserved_credits,
        monthly_limit = excluded.monthly_limit,
        run_id = excluded.run_id,
        claim_token = excluded.claim_token,
        status = 'active', result = null, actual_tokens = null,
        expires_at = excluded.expires_at, finalized_at = null;
  update public.accounts set token_balance = balance - credits where id = p_account_id;
  return jsonb_build_object('status', 'reserved');
end
$$;

revoke all on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) from public, anon, authenticated;
grant execute on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) to service_role;

comment on function public.reserve_token_usage(uuid,text,bigint,bigint,uuid,uuid) is
  'ADR 003: legacy admission, now fail-closed on runtime.system_controls kill switch / claims pause.';

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.expire_legacy_reservations — bounded cleanup, exactly-once refund, deterministic
-- account lock order to avoid deadlocks with other account-locking processes.
-- ---------------------------------------------------------------------------------------------

create function billing_legacy.expire_legacy_reservations(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_expired_count integer := 0;
  v_refunded_credits bigint := 0;
  v_rows_touched integer;
begin
  if p_limit not between 1 and 10000 then
    raise exception using errcode = '22023', message = 'invalid expiry batch limit';
  end if;

  for v_row in
    select reservation.id, reservation.account_id, reservation.reserved_credits
    from public.token_usage_reservations as reservation
    where reservation.status = 'active' and reservation.expires_at <= now()
    order by reservation.account_id, reservation.expires_at, reservation.id
    for update skip locked
    limit p_limit
  loop
    -- Lock the account row before mutating it; scan order above is already account_id-ascending,
    -- so this preserves a single deterministic lock order across concurrent cleanup runs.
    perform 1 from public.accounts where id = v_row.account_id for update;

    -- Guard the refund inside the same statement as the terminal status transition so a retry of
    -- this loop iteration (or a concurrent cleanup run that skipped the row-lock race) can never
    -- refund the same reservation twice: the WHERE clause only matches while still 'active'.
    with settled as (
      update public.token_usage_reservations
      set status = 'expired'
      where id = v_row.id and account_id = v_row.account_id and status = 'active'
      returning reserved_credits
    )
    update public.accounts as account
    set token_balance = account.token_balance + settled.reserved_credits
    from settled
    where account.id = v_row.account_id;

    get diagnostics v_rows_touched = row_count;
    if v_rows_touched > 0 then
      v_expired_count := v_expired_count + 1;
      v_refunded_credits := v_refunded_credits + v_row.reserved_credits;
    end if;
  end loop;

  return jsonb_build_object('expired_count', v_expired_count, 'refunded_credits', v_refunded_credits);
end
$$;

revoke all on function billing_legacy.expire_legacy_reservations(integer) from public, anon, authenticated;
grant execute on function billing_legacy.expire_legacy_reservations(integer) to service_role;

comment on function billing_legacy.expire_legacy_reservations(integer) is
  'Service-role-only cleanup: refunds overdue legacy reservations exactly once via a guarded status transition.';

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.quad_zero_check — read-only cutover readiness signal
-- ---------------------------------------------------------------------------------------------

create function billing_legacy.quad_zero_check()
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'autonomous_run_checkpoints_nonterminal', (
      select count(*) from public.autonomous_run_checkpoints
      where status in ('active', 'queued', 'running')
    ),
    'workflow_runs_nonterminal', (
      select count(*) from runtime.workflow_runs
      where current_state not in ('completed', 'failed', 'denied', 'dead_letter', 'cancelled')
    ),
    'compute_jobs_pending_or_running', (
      select count(*) from runtime.compute_jobs
      where status in ('pending', 'running')
    ),
    'token_usage_reservations_active', (
      select count(*) from public.token_usage_reservations where status = 'active'
    )
  );
$$;

revoke all on function billing_legacy.quad_zero_check() from public, anon, authenticated;
grant execute on function billing_legacy.quad_zero_check() to service_role;

comment on function billing_legacy.quad_zero_check() is
  'Read-only. All four counts must be zero, per account fully drained, before the manual revoke runbook in ADR 003 §5.';

-- ---------------------------------------------------------------------------------------------
-- billing_legacy.reconciliation_report — read-only migration reconciliation, computed directly
-- from drain_snapshots joined to the pricing matrix each snapshot was converted under, the
-- legacy_migration bucket it funded, and the grant ledger row that recorded the funding. This is
-- the actual cutover-migration check (conservation of buckets/allocations/ledger under ongoing
-- reserve/finalize/release traffic is a separate, already-covered invariant — see
-- supabase/tests/billing_usage_invariants.sql).
-- ---------------------------------------------------------------------------------------------

create function billing_legacy.reconciliation_report()
returns jsonb
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  v_expected_units bigint;
  v_bucket_units bigint;
  v_ledger_grant_units bigint;
  v_mismatched_accounts integer;
begin
  select coalesce(sum(
    greatest(floor(
      snapshot.snapshotted_balance * (matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric
    )::bigint, 0)
  ), 0)
  into v_expected_units
  from billing_legacy.drain_snapshots as snapshot
  join billing.pricing_matrices as matrix on matrix.version = snapshot.pricing_matrix_version;

  select coalesce(sum(bucket.total_units), 0)
  into v_bucket_units
  from billing_legacy.drain_snapshots as snapshot
  join billing.usage_buckets as bucket
    on bucket.account_id = snapshot.account_id and bucket.id = snapshot.granted_bucket_id;

  select coalesce(sum(ledger.units), 0)
  into v_ledger_grant_units
  from billing_legacy.drain_snapshots as snapshot
  join billing.usage_ledger as ledger
    on ledger.account_id = snapshot.account_id and ledger.bucket_id = snapshot.granted_bucket_id
   and ledger.event_type = 'grant';

  select count(*)
  into v_mismatched_accounts
  from billing_legacy.drain_snapshots as snapshot
  join billing.pricing_matrices as matrix on matrix.version = snapshot.pricing_matrix_version
  left join billing.usage_buckets as bucket
    on bucket.account_id = snapshot.account_id and bucket.id = snapshot.granted_bucket_id
  left join billing.usage_ledger as ledger
    on ledger.account_id = snapshot.account_id and ledger.bucket_id = snapshot.granted_bucket_id
   and ledger.event_type = 'grant'
  where greatest(floor(
          snapshot.snapshotted_balance * (matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric
        )::bigint, 0) is distinct from coalesce(bucket.total_units, 0)
     or greatest(floor(
          snapshot.snapshotted_balance * (matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric
        )::bigint, 0) is distinct from coalesce(ledger.units, 0);

  return jsonb_build_object(
    'expected_units', v_expected_units,
    'bucket_units', v_bucket_units,
    'ledger_grant_units', v_ledger_grant_units,
    'bucket_delta', v_bucket_units - v_expected_units,
    'ledger_delta', v_ledger_grant_units - v_expected_units,
    'mismatched_accounts', v_mismatched_accounts
  );
end
$$;

revoke all on function billing_legacy.reconciliation_report() from public, anon, authenticated;
grant execute on function billing_legacy.reconciliation_report() to service_role;

comment on function billing_legacy.reconciliation_report() is
  'Read-only. Recomputes expected legacy-migration units from drain_snapshots x pricing_matrices and compares against actual usage_buckets/usage_ledger; all deltas/mismatches must be zero before global cutover activates.';

-- ---------------------------------------------------------------------------------------------
-- runtime.enter_billing_maintenance — atomic entering half of a maintenance transition. There was
-- previously no RPC for this (operators set the pause flags directly); billing.activate_global_
-- cutover requires claims_paused AND ingestion_paused to already be true with valid metadata
-- before it will run, so a dedicated, validated, service-role-only entry point replaces the manual
-- direct UPDATE. Does not touch kill_switch_active — this is a metering-admission maintenance
-- window, not the workflow-runtime kill switch, and the two are independently controllable
-- (system_controls_kill_switch_check only requires claims_paused when kill_switch_active is set,
-- not the reverse).
-- ---------------------------------------------------------------------------------------------

create function runtime.enter_billing_maintenance(p_actor text, p_reason_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row runtime.system_controls%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor is null or char_length(p_actor) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid maintenance actor';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid maintenance reason code';
  end if;

  -- Kill switch independence (ADR 003 §5): the kill switch is an unrelated incident control.
  -- Fail closed rather than silently overwriting its reason_code/activated_by/activated_at.
  select controls.* into strict v_row
  from runtime.system_controls as controls
  where controls.singleton
  for update;
  if v_row.kill_switch_active then
    raise exception using errcode = '55000',
      message = 'kill switch is active; billing maintenance cannot start until it is cleared independently';
  end if;

  -- Single atomic UPDATE: flags on and metadata set together, matching
  -- system_controls_activation_check (ADR 003 §5).
  update runtime.system_controls
  set claims_paused = true,
      ingestion_paused = true,
      reason_code = p_reason_code,
      activated_by = p_actor,
      activated_at = v_now,
      control_epoch = control_epoch + 1,
      updated_at = v_now
  where singleton
  returning * into v_row;

  return jsonb_build_object(
    'claims_paused', v_row.claims_paused,
    'ingestion_paused', v_row.ingestion_paused,
    'reason_code', v_row.reason_code,
    'activated_by', v_row.activated_by,
    'activated_at', v_row.activated_at,
    'control_epoch', v_row.control_epoch
  );
end
$$;

revoke all on function runtime.enter_billing_maintenance(text, text) from public, anon, authenticated;
grant execute on function runtime.enter_billing_maintenance(text, text) to service_role;

comment on function runtime.enter_billing_maintenance(text, text) is
  'ADR 003: single atomic UPDATE setting claims_paused + ingestion_paused and maintenance metadata together.';

-- ---------------------------------------------------------------------------------------------
-- runtime.resume_from_maintenance — atomic clearing half of a maintenance transition
-- ---------------------------------------------------------------------------------------------

create function runtime.resume_from_maintenance(p_actor text, p_reason_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row runtime.system_controls%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_actor is null or char_length(p_actor) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid resume actor';
  end if;
  -- p_reason_code is optional (why the resume happened need not match the entering reason_code),
  -- but if supplied it must still be a well-formed reason code, and it is returned to the caller
  -- to log — it is not a dead parameter.
  if p_reason_code is not null and p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid resume reason code';
  end if;

  -- Kill switch independence (ADR 003 §5): this RPC clears billing maintenance only. It must never
  -- change kill_switch_active, and must fail closed if an incident is still active so a billing
  -- resume can never be mistaken for clearing the kill switch.
  select controls.* into strict v_row
  from runtime.system_controls as controls
  where controls.singleton
  for update;
  if v_row.kill_switch_active then
    raise exception using errcode = '55000',
      message = 'kill switch is active; clear it independently before resuming from billing maintenance';
  end if;

  -- Single atomic UPDATE: flags off and metadata cleared together, matching
  -- system_controls_activation_check (ADR 003 §5). The resume actor/reason are audited via
  -- runtime.audit_events, not stored on the now-inactive singleton row.
  -- runtime.audit_events requires a tenant account_id and workflow-scoped correlation_id; this is
  -- a control-plane, not tenant-scoped, action, so it does not fit that table. The resume actor
  -- and reason are returned to the caller (an operator-facing Edge Function) to log instead.
  update runtime.system_controls
  set claims_paused = false,
      ingestion_paused = false,
      reason_code = null,
      activated_by = null,
      activated_at = null,
      control_epoch = control_epoch + 1,
      updated_at = v_now
  where singleton
  returning * into v_row;

  return jsonb_build_object(
    'resumed_by', p_actor,
    'resume_reason_code', p_reason_code,
    'resumed_at', v_now,
    'control_epoch', v_row.control_epoch
  );
end
$$;

revoke all on function runtime.resume_from_maintenance(text, text) from public, anon, authenticated;
grant execute on function runtime.resume_from_maintenance(text, text) to service_role;

comment on function runtime.resume_from_maintenance(text, text) is
  'ADR 003: single atomic UPDATE clearing all system_controls pause flags and metadata together.';

-- ---------------------------------------------------------------------------------------------
-- billing.activate_global_cutover — the one-way, whole-environment cutover. Requires the caller to
-- have already put the system into maintenance via runtime.enter_billing_maintenance (claims_paused
-- AND ingestion_paused, with reason_code/activated_by/activated_at all set) and requires
-- billing_legacy.quad_zero_check() to report all four counts as exactly zero. On success: snapshots
-- every account deterministically (ascending account_id, all locked for update in the same
-- transaction as this function body), grants source='legacy_migration' buckets with a 12-month TTL
-- funded by the active pricing matrix's legacy_credit_to_unit conversion, writes one append-only
-- 'grant' ledger row per funded account, then atomically clears the maintenance flags/metadata
-- (same shape as runtime.resume_from_maintenance) and flips billing.cutover_state.v2_active — all
-- in the one transaction this function body runs in. This function is defined here but never
-- invoked by any migration: the actual cutover is a manual, per-environment operator action (see
-- ADR 003 §5), run only after a human has read quad_zero_check() output for that specific
-- environment.
-- ---------------------------------------------------------------------------------------------

create function billing.activate_global_cutover(p_actor text, p_reason_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutover billing.cutover_state%rowtype;
  v_control runtime.system_controls%rowtype;
  v_quad jsonb;
  v_matrix billing.pricing_matrices%rowtype;
  v_factor numeric;
  v_now timestamptz := clock_timestamp();
  v_account record;
  v_granted_units bigint;
  v_bucket_id uuid;
  v_accounts_migrated integer := 0;
  v_units_migrated bigint := 0;
  v_new_control_epoch bigint;
  v_reconciliation jsonb;
begin
  if p_actor is null or char_length(p_actor) not between 1 and 160 then
    raise exception using errcode = '22023', message = 'invalid activation actor';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception using errcode = '22023', message = 'invalid activation reason code';
  end if;

  -- Lock system_controls before cutover_state (same order as the reserve/maintenance paths) and
  -- check the kill switch BEFORE the already-active short-circuit below: a kill switch activated
  -- after v2 is already live must still fail this call closed rather than silently no-op-succeeding.
  select controls.* into strict v_control
  from runtime.system_controls as controls
  where controls.singleton
  for update;
  if v_control.kill_switch_active then
    raise exception using errcode = '55000',
      message = 'kill switch is active; global cutover cannot run until it is cleared independently';
  end if;

  select cutover.* into strict v_cutover
  from billing.cutover_state as cutover
  where cutover.singleton
  for update;
  if v_cutover.v2_active then
    return jsonb_build_object(
      'status', 'already_active',
      'activated_at', v_cutover.activated_at,
      'cutover_epoch', v_cutover.cutover_epoch
    );
  end if;

  if not (v_control.claims_paused and v_control.ingestion_paused) then
    raise exception using errcode = '55000',
      message = 'global cutover requires claims_paused and ingestion_paused; call runtime.enter_billing_maintenance first';
  end if;
  if v_control.reason_code is null or v_control.activated_by is null or v_control.activated_at is null then
    raise exception using errcode = '55000', message = 'system_controls maintenance metadata incomplete';
  end if;

  v_quad := billing_legacy.quad_zero_check();
  if (v_quad ->> 'autonomous_run_checkpoints_nonterminal')::integer <> 0
    or (v_quad ->> 'workflow_runs_nonterminal')::integer <> 0
    or (v_quad ->> 'compute_jobs_pending_or_running')::integer <> 0
    or (v_quad ->> 'token_usage_reservations_active')::integer <> 0 then
    raise exception using errcode = '55000',
      message = format('quad-zero check not clear, cannot activate global cutover: %s', v_quad);
  end if;

  select matrix.* into v_matrix
  from billing.pricing_matrices as matrix
  where matrix.is_active
  limit 1;
  if not found then
    raise exception using errcode = '55000', message = 'no active pricing matrix for global cutover conversion';
  end if;
  v_factor := coalesce((v_matrix.conversion_rules ->> 'legacy_credit_to_unit')::numeric, 0);
  if v_factor <= 0 then
    raise exception using errcode = '55000',
      message = 'pricing matrix missing legacy_credit_to_unit conversion rule';
  end if;

  -- Deterministic, single-transaction snapshot of every account, locked in ascending account_id
  -- order. Explicit conversion (never implicit 1:1) via legacy_credit_to_unit, exactly like
  -- billing_legacy.expire_legacy_reservations locks accounts in the same ascending order.
  for v_account in
    select account.id, account.token_balance
    from public.accounts as account
    order by account.id
    for update
  loop
    if exists (
      select 1 from billing_legacy.drain_snapshots as snapshot where snapshot.account_id = v_account.id
    ) then
      continue;
    end if;

    v_granted_units := greatest(floor(v_account.token_balance * v_factor)::bigint, 0);
    v_bucket_id := null;

    -- Composite tenant integrity: zero-unit accounts store a NULL bucket id (ADR 003 §5).
    if v_granted_units > 0 then
      v_bucket_id := gen_random_uuid();
      insert into billing.usage_buckets (
        id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at
      ) values (
        v_bucket_id, v_account.id, 'legacy_migration', v_matrix.version,
        v_granted_units, v_granted_units, v_now + interval '12 months'
      );

      insert into billing.usage_ledger (account_id, event_type, units, bucket_id, details)
      values (
        v_account.id, 'grant', v_granted_units, v_bucket_id,
        jsonb_build_object('reason', 'legacy_migration', 'snapshotted_balance', v_account.token_balance)
      );
      v_units_migrated := v_units_migrated + v_granted_units;
    end if;

    insert into billing_legacy.drain_snapshots (
      account_id, snapshotted_balance, granted_bucket_id, pricing_matrix_version
    ) values (
      v_account.id, v_account.token_balance, v_bucket_id, v_matrix.version
    );

    v_accounts_migrated := v_accounts_migrated + 1;
  end loop;

  -- Fail-closed reconciliation gate (ADR 003 §5): recompute expected legacy-migration units from
  -- the snapshots just written and compare against the buckets/ledger just written, in the same
  -- transaction. Any nonzero delta or mismatch aborts the whole cutover — nothing below this point
  -- (clearing maintenance, flipping v2_active) runs, and the entire transaction rolls back.
  v_reconciliation := billing_legacy.reconciliation_report();
  if (v_reconciliation ->> 'bucket_delta')::bigint <> 0
    or (v_reconciliation ->> 'ledger_delta')::bigint <> 0
    or (v_reconciliation ->> 'mismatched_accounts')::integer <> 0 then
    raise exception using errcode = '55000',
      message = format('cutover reconciliation is not clear, refusing to activate: %s', v_reconciliation);
  end if;

  -- Atomically clear maintenance metadata/flags and bump control_epoch — same shape as
  -- runtime.resume_from_maintenance — in the same transaction as the snapshot loop above.
  update runtime.system_controls
  set claims_paused = false,
      ingestion_paused = false,
      reason_code = null,
      activated_by = null,
      activated_at = null,
      control_epoch = control_epoch + 1,
      updated_at = v_now
  where singleton
  returning control_epoch into v_new_control_epoch;

  update billing.cutover_state
  set v2_active = true,
      activated_by = p_actor,
      reason_code = p_reason_code,
      activated_at = v_now,
      cutover_epoch = cutover_epoch + 1
  where singleton;

  return jsonb_build_object(
    'status', 'activated',
    'activated_by', p_actor,
    'reason_code', p_reason_code,
    'activated_at', v_now,
    'accounts_migrated', v_accounts_migrated,
    'units_migrated', v_units_migrated,
    'system_controls_epoch', v_new_control_epoch,
    'reconciliation', v_reconciliation
  );
end
$$;

revoke all on function billing.activate_global_cutover(text, text) from public, anon, authenticated;
grant execute on function billing.activate_global_cutover(text, text) to service_role;

comment on function billing.activate_global_cutover(text, text) is
  'ADR 003: one-way global cutover. Never invoked by a migration — manual operator action per the runbook.';
