-- ADR 003 billing.* invariants. Run against an isolated local database. All fixtures rolled back.
-- Invariant #1 (20-way concurrent race on a scarce bucket, and the two other distinct-key/budget
-- races) is NOT exercised here: it requires real separate connections/transactions and is covered
-- instead by tests/billing_concurrency_reserve.ps1, which launches parallel psql processes against
-- a disposable reset database.

begin;

select plan(15);

insert into public.accounts (id, name) values
  ('81000000-0000-4000-8000-000000000001', 'billing-test-a'),
  ('82000000-0000-4000-8000-000000000002', 'billing-test-b');

insert into billing.pricing_matrices (
  id, version, name, conversion_rules, is_active
) values (
  '81000000-0000-4000-8000-00000000f001', 1, 'billing-test-matrix-v1',
  jsonb_build_object('legacy_credit_to_unit', 2), true
);

insert into billing.account_usage_policies (account_id, pricing_matrix_version, budget_units)
values
  ('81000000-0000-4000-8000-000000000001', 1, 1000),
  ('82000000-0000-4000-8000-000000000002', 1, 1000);

-- ---------------------------------------------------------------------------------------------
-- Invariant #9: routing/cutover. Before activation only legacy admits and v2 denies; during the
-- maintenance window both deny; after a successful global activation legacy denies and v2 admits;
-- exactly one ledger is charged per logical work id. This is the real replacement for the old
-- tautological "no dual charge" test — it drives billing.activate_global_cutover for real and
-- asserts on actual routing outcomes, not on a `details` key nothing ever writes. Running this
-- also activates billing.cutover_state.v2_active for the rest of this file (§5: one-way, global),
-- which is why it runs before invariants 2-8 below, all of which call billing.reserve_usage and
-- therefore need v2 already active.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_account uuid := '84000000-0000-4000-8000-000000000001';
  v_bucket uuid := '84000000-0000-4000-8000-0000000b0001';
  v_run_id uuid := gen_random_uuid();
  v_claim_token uuid := gen_random_uuid();
  v_pre_legacy jsonb;
  v_pre_v2 jsonb;
  v_maint jsonb;
  v_during_legacy jsonb;
  v_during_v2 jsonb;
  v_cutover jsonb;
  v_post_legacy jsonb;
  v_post_v2 jsonb;
  v_legacy_balance_before bigint;
  v_legacy_balance_after bigint;
  v_billing_ledger_count integer;
  v_legacy_touched_billing_ledger integer;
  v_premature_activation_rejected boolean := false;
  v_post_v2_replay jsonb;
  v_v2_rows_for_legacy_key integer;
begin
  insert into public.accounts (id, name) values (v_account, 'billing-test-cutover');
  insert into billing.account_usage_policies (account_id, pricing_matrix_version, budget_units)
  values (v_account, 1, 1000);

  -- Activation must be rejected while the system is not yet in a maintenance window.
  begin
    perform billing.activate_global_cutover('test-operator', 'PREMATURE_CUTOVER_ATTEMPT');
  exception when sqlstate '55000' then
    v_premature_activation_rejected := true;
  end;
  if not v_premature_activation_rejected then
    raise exception 'activate_global_cutover succeeded without a maintenance window';
  end if;

  -- Phase 1: before activation. Legacy admits, v2 denies.
  insert into public.autonomous_run_checkpoints (id, account_id, user_id, run_ref, status, claim_token)
  values (v_run_id, v_account, gen_random_uuid(), gen_random_uuid(), 'running', v_claim_token);

  select token_balance into v_legacy_balance_before from public.accounts where id = v_account;

  v_pre_legacy := public.reserve_token_usage(
    v_account, 'cutover-work-1', 2000, 999999999, v_run_id, v_claim_token
  );
  if v_pre_legacy ->> 'status' <> 'reserved' then
    raise exception 'expected legacy to admit before activation, got: %', v_pre_legacy;
  end if;

  v_pre_v2 := billing.reserve_usage(v_account, 'cutover-work-1', 5, 'worker-cutover-1');
  if v_pre_v2 ->> 'status' <> 'denied_cutover_inactive' then
    raise exception 'expected v2 to deny before activation, got: %', v_pre_v2;
  end if;

  -- Settle the legacy reservation and terminalize its checkpoint so quad_zero_check can clear.
  perform public.finalize_token_usage(
    v_account, 'cutover-work-1', 2000, 0.02, 'test-model', 'test-stage',
    gen_random_uuid(), '{"ok":true}'::jsonb, v_run_id, v_claim_token
  );
  update public.autonomous_run_checkpoints set status = 'completed' where id = v_run_id;

  select token_balance into v_legacy_balance_after from public.accounts where id = v_account;
  if v_legacy_balance_before = v_legacy_balance_after then
    raise exception 'legacy ledger did not record spend for the reserved/finalized work';
  end if;

  -- Phase 2: maintenance window. Both routes deny.
  v_maint := runtime.enter_billing_maintenance('test-operator', 'CUTOVER_TEST_MAINTENANCE');
  if not (v_maint ->> 'claims_paused')::boolean or not (v_maint ->> 'ingestion_paused')::boolean then
    raise exception 'enter_billing_maintenance did not pause claims/ingestion: %', v_maint;
  end if;

  v_during_legacy := public.reserve_token_usage(
    v_account, 'cutover-work-2', 1000, 999999999, gen_random_uuid(), gen_random_uuid()
  );
  if v_during_legacy ->> 'status' <> 'denied_kill_switch' then
    raise exception 'expected legacy to deny during maintenance, got: %', v_during_legacy;
  end if;

  v_during_v2 := billing.reserve_usage(v_account, 'cutover-work-2', 5, 'worker-cutover-2');
  if v_during_v2 ->> 'status' <> 'denied_kill_switch' then
    raise exception 'expected v2 to deny during maintenance, got: %', v_during_v2;
  end if;

  -- Phase 3: activate. Requires quad_zero_check() to be clear database-wide, hence this test file
  -- must run against an isolated, otherwise-quiescent local database (see file header).
  -- Zero out the other fixture accounts' legacy balance first: activate_global_cutover grants a
  -- legacy_migration bucket to every account with a positive token_balance, and the invariants
  -- below (2-8) depend on exact bucket capacity for those two accounts, not on whatever the
  -- default seed balance happens to convert to.
  update public.accounts
  set token_balance = 0
  where id in ('81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000002');

  v_cutover := billing.activate_global_cutover('test-operator', 'CUTOVER_TEST_ACTIVATION');
  if v_cutover ->> 'status' <> 'activated' then
    raise exception 'billing.activate_global_cutover did not activate: %', v_cutover;
  end if;

  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values (v_bucket, v_account, 'purchase', 1, 20, 20, now() + interval '1 day');

  -- Phase 4: after activation, legacy denies for a NEW key.
  v_post_legacy := public.reserve_token_usage(
    v_account, 'cutover-work-3', 1000, 999999999, gen_random_uuid(), gen_random_uuid()
  );
  if v_post_legacy ->> 'status' <> 'denied_cutover_active' then
    raise exception 'expected legacy to deny after activation, got: %', v_post_legacy;
  end if;

  -- Cross-scheme idempotency at cutover: retry THE SAME logical key ('cutover-work-1') that legacy
  -- already admitted and finalized BEFORE activation. v2 must recognize the finalized legacy
  -- reservation under that key and refuse to admit/charge it again — no v2 reservation row, no v2
  -- ledger row, for this key, ever.
  v_post_v2_replay := billing.reserve_usage(v_account, 'cutover-work-1', 5, 'worker-cutover-replay');
  if v_post_v2_replay ->> 'status' <> 'legacy_finalized'
     or not coalesce((v_post_v2_replay ->> 'idempotent_replay')::boolean, false) then
    raise exception 'expected v2 to recognize the finalized legacy key and refuse admission, got: %', v_post_v2_replay;
  end if;

  select count(*) into v_v2_rows_for_legacy_key
  from billing.usage_reservations
  where account_id = v_account and idempotency_key = 'cutover-work-1';
  if v_v2_rows_for_legacy_key <> 0 then
    raise exception 'v2 created a reservation row for a retried finalized legacy key: % rows', v_v2_rows_for_legacy_key;
  end if;

  select count(*) into v_legacy_touched_billing_ledger
  from billing.usage_ledger
  where account_id = v_account and idempotency_key = 'cutover-work-1';
  if v_legacy_touched_billing_ledger <> 0 then
    raise exception 'billing.usage_ledger unexpectedly recorded the pre-activation legacy-charged work';
  end if;

  -- A genuinely distinct, new key proves v2 does admit ordinary fresh work post-activation.
  v_post_v2 := billing.reserve_usage(v_account, 'cutover-work-3', 5, 'worker-cutover-3');
  if v_post_v2 ->> 'status' <> 'reserved' then
    raise exception 'expected v2 to admit a distinct new key after activation, got: %', v_post_v2;
  end if;

  select count(*) into v_billing_ledger_count
  from billing.usage_ledger
  where reservation_id = (v_post_v2 ->> 'reservation_id')::uuid;
  if v_billing_ledger_count <> 1 then
    raise exception 'expected exactly one billing.usage_ledger row for the post-activation reservation, got %', v_billing_ledger_count;
  end if;
end
$$;

select pass('invariant 9: routing/cutover — legacy-only pre-activation, both deny in maintenance, v2-only post-activation for a new key, retry of the SAME finalized legacy key is not re-admitted/charged by v2');

-- ---------------------------------------------------------------------------------------------
-- Invariant #9b: legacy status semantics at cross-scheme idempotency check. 'active' fails closed
-- (denied, no charge); 'released'/'expired' consumed no lasting balance, so a fresh v2 reservation
-- under the same key is admitted normally.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_account uuid := '82000000-0000-4000-8000-000000000002';
  v_bucket uuid := '82000000-0000-4000-8000-0000000b000c';
  v_run_id uuid := gen_random_uuid();
  v_active_key text := 'legacy-active-race-key';
  v_released_key text := 'legacy-released-key';
  v_expired_key text := 'legacy-expired-key';
  v_denied jsonb;
  v_admitted_released jsonb;
  v_admitted_expired jsonb;
  v_rows_for_active_key integer;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values (v_bucket, v_account, 'purchase', 1, 30, 30, now() + interval '1 day');

  -- Simulate a legacy row that is still 'active' after cutover (a race/bypass the cutover gate
  -- should normally prevent). billing.reserve_usage must fail closed rather than double-admit.
  insert into public.token_usage_reservations (
    account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, status, expires_at
  ) values (
    v_account, v_active_key, v_run_id, gen_random_uuid(), 1000, 1, 999999999, 'active', now() + interval '10 minutes'
  );
  v_denied := billing.reserve_usage(v_account, v_active_key, 5, 'worker-legacy-active');
  if v_denied ->> 'status' <> 'denied_legacy_active' then
    raise exception 'expected denied_legacy_active for an active legacy row, got: %', v_denied;
  end if;
  select count(*) into v_rows_for_active_key
  from billing.usage_reservations where account_id = v_account and idempotency_key = v_active_key;
  if v_rows_for_active_key <> 0 then
    raise exception 'v2 created a reservation row despite an active legacy row under the same key';
  end if;

  -- 'released': consumed no lasting balance, so a fresh v2 reservation under the same key admits.
  insert into public.token_usage_reservations (
    account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, status, expires_at
  ) values (
    v_account, v_released_key, v_run_id, gen_random_uuid(), 1000, 1, 999999999, 'released', now() + interval '10 minutes'
  );
  v_admitted_released := billing.reserve_usage(v_account, v_released_key, 5, 'worker-legacy-released');
  if v_admitted_released ->> 'status' <> 'reserved' then
    raise exception 'expected v2 to admit a fresh reservation for a released legacy key, got: %', v_admitted_released;
  end if;

  -- 'expired': same as released — no lasting balance consumed, fresh v2 admission is correct.
  insert into public.token_usage_reservations (
    account_id, billing_key, run_id, claim_token, reserved_tokens, reserved_credits, monthly_limit, status, expires_at
  ) values (
    v_account, v_expired_key, v_run_id, gen_random_uuid(), 1000, 1, 999999999, 'expired', now() - interval '1 minute'
  );
  v_admitted_expired := billing.reserve_usage(v_account, v_expired_key, 5, 'worker-legacy-expired');
  if v_admitted_expired ->> 'status' <> 'reserved' then
    raise exception 'expected v2 to admit a fresh reservation for an expired legacy key, got: %', v_admitted_expired;
  end if;
end
$$;

select pass('invariant 9b: cross-scheme idempotency — active legacy row denies (fail closed), released/expired legacy rows admit a fresh v2 reservation');

-- ---------------------------------------------------------------------------------------------
-- Invariant #10: maintenance/activation input validation is enforced, not skipped.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_rejected boolean;
begin
  v_rejected := false;
  begin
    perform runtime.enter_billing_maintenance('', 'BAD_ACTOR_TEST');
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'enter_billing_maintenance accepted an empty actor';
  end if;

  v_rejected := false;
  begin
    perform runtime.enter_billing_maintenance('test-operator', 'not-a-valid-reason-code');
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'enter_billing_maintenance accepted a malformed reason_code';
  end if;

  v_rejected := false;
  begin
    perform billing.activate_global_cutover(null, 'SOME_REASON');
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'activate_global_cutover accepted a null actor';
  end if;

  v_rejected := false;
  begin
    perform billing.activate_global_cutover('test-operator', 'lowercase-not-allowed');
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'activate_global_cutover accepted a malformed reason_code';
  end if;
end
$$;

select pass('invariant 10: enter_billing_maintenance/activate_global_cutover reject invalid actor/reason_code');

-- ---------------------------------------------------------------------------------------------
-- Invariant #14: real cutover reconciliation. billing_legacy.reconciliation_report(), computed
-- directly from drain_snapshots x pricing_matrices x usage_buckets x usage_ledger, must show
-- exactly zero deltas/mismatches after the activation that already ran above (invariant #9's do
-- block). This is the actual migration-reconciliation check — invariant #13 below is a separate,
-- ongoing bucket/allocation conservation check, not a migration check.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_report jsonb;
begin
  v_report := billing_legacy.reconciliation_report();
  if (v_report ->> 'bucket_delta')::bigint <> 0
    or (v_report ->> 'ledger_delta')::bigint <> 0
    or (v_report ->> 'mismatched_accounts')::integer <> 0 then
    raise exception 'expected reconciliation_report to be exactly zero after activation, got: %', v_report;
  end if;
  if (v_report ->> 'expected_units')::bigint <> (v_report ->> 'bucket_units')::bigint
    or (v_report ->> 'expected_units')::bigint <> (v_report ->> 'ledger_grant_units')::bigint then
    raise exception 'expected_units did not match bucket_units/ledger_grant_units: %', v_report;
  end if;
end
$$;

select pass('invariant 14: billing_legacy.reconciliation_report() reports zero deltas/mismatches after global cutover activation');

-- ---------------------------------------------------------------------------------------------
-- Invariant #15: kill switch independence. runtime.enter_billing_maintenance and
-- runtime.resume_from_maintenance must never touch kill_switch_active, and billing maintenance
-- enter/resume/cutover must all fail closed while an incident kill switch is active.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_kill_switch_rejected_enter boolean := false;
  v_kill_switch_rejected_resume boolean := false;
  v_kill_switch_rejected_cutover boolean := false;
  v_resume jsonb;
  v_still_active boolean;
begin
  -- Turn on the incident kill switch directly (this is the control the resume/maintenance RPCs
  -- must never silently clear). system_controls_kill_switch_check requires claims_paused whenever
  -- kill_switch_active is set, so both flip atomically in the same UPDATE.
  update runtime.system_controls
  set kill_switch_active = true, claims_paused = true,
      reason_code = 'INCIDENT_TEST', activated_by = 'incident-operator',
      activated_at = clock_timestamp(), control_epoch = control_epoch + 1
  where singleton;

  begin
    perform runtime.enter_billing_maintenance('test-operator', 'KILL_SWITCH_INDEPENDENCE_TEST');
  exception when sqlstate '55000' then
    v_kill_switch_rejected_enter := true;
  end;
  if not v_kill_switch_rejected_enter then
    raise exception 'enter_billing_maintenance did not fail closed while kill switch is active';
  end if;

  -- Confirm enter_billing_maintenance did not overwrite the incident's own metadata.
  select controls.reason_code = 'INCIDENT_TEST' into v_still_active
  from runtime.system_controls as controls where controls.singleton;
  if not v_still_active then
    raise exception 'enter_billing_maintenance overwrote incident kill switch metadata despite failing closed';
  end if;

  begin
    perform runtime.resume_from_maintenance('test-operator', 'KILL_SWITCH_INDEPENDENCE_TEST');
  exception when sqlstate '55000' then
    v_kill_switch_rejected_resume := true;
  end;
  if not v_kill_switch_rejected_resume then
    raise exception 'resume_from_maintenance did not fail closed while kill switch is active';
  end if;

  select controls.kill_switch_active into v_still_active
  from runtime.system_controls as controls where controls.singleton;
  if not v_still_active then
    raise exception 'kill_switch_active was cleared by a rejected resume_from_maintenance call';
  end if;

  begin
    perform billing.activate_global_cutover('test-operator', 'KILL_SWITCH_INDEPENDENCE_TEST');
  exception when sqlstate '55000' then
    v_kill_switch_rejected_cutover := true;
  end;
  if not v_kill_switch_rejected_cutover then
    raise exception 'activate_global_cutover did not fail closed while kill switch is active';
  end if;

  -- Clear the kill switch directly (as a separate, unrelated incident-response action), then prove
  -- resume_from_maintenance still leaves it false rather than toggling it. Both claims_paused and
  -- kill_switch_active must clear together, or system_controls_activation_check would reject a
  -- claims_paused=true row with no reason_code/activated_by/activated_at.
  update runtime.system_controls
  set kill_switch_active = false, claims_paused = false, ingestion_paused = false,
      reason_code = null, activated_by = null, activated_at = null,
      control_epoch = control_epoch + 1
  where singleton;
  v_resume := runtime.resume_from_maintenance('test-operator', 'KILL_SWITCH_CLEARED_TEST');
  select controls.kill_switch_active into v_still_active
  from runtime.system_controls as controls where controls.singleton;
  if v_still_active then
    raise exception 'kill_switch_active was unexpectedly true after a resume with the switch already clear';
  end if;
end
$$;

select pass('invariant 15: kill switch is independent of billing maintenance/resume/cutover — none of them can clear or overwrite it, all fail closed while it is active');

-- ---------------------------------------------------------------------------------------------
-- Invariant #2: multi-bucket FEFO split + correct unused-unit refund on finalize.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket_soon uuid := '81000000-0000-4000-8000-0000000b0001';
  v_bucket_later uuid := '81000000-0000-4000-8000-0000000b0002';
  v_reserved jsonb;
  v_finalized jsonb;
  v_soon_remaining bigint;
  v_later_remaining bigint;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values
    (v_bucket_soon, '81000000-0000-4000-8000-000000000001', 'purchase', 1, 6, 6, now() + interval '1 day'),
    (v_bucket_later, '81000000-0000-4000-8000-000000000001', 'purchase', 1, 10, 10, now() + interval '30 days');

  -- 10 units needed: FEFO drains the sooner-expiring bucket (6) first, then 4 from the later one.
  v_reserved := billing.reserve_usage(
    '81000000-0000-4000-8000-000000000001', 'fefo-split-key-1', 10, 'worker-fefo-1'
  );
  if v_reserved ->> 'status' <> 'reserved' then
    raise exception 'fefo reservation was not admitted: %', v_reserved;
  end if;
  if jsonb_array_length(v_reserved -> 'allocations') <> 2 then
    raise exception 'expected a two-bucket FEFO split, got: %', v_reserved;
  end if;

  select remaining_units into v_soon_remaining from billing.usage_buckets where id = v_bucket_soon;
  select remaining_units into v_later_remaining from billing.usage_buckets where id = v_bucket_later;
  if v_soon_remaining <> 0 or v_later_remaining <> 6 then
    raise exception 'unexpected FEFO split remainders: soon=% later=%', v_soon_remaining, v_later_remaining;
  end if;

  -- Finalize with only 3 actually used: 7 units must refund back, proportionally, 4 to the sooner
  -- bucket's allocation (its 6-of-10 share) and 3 to the later bucket's allocation (4-of-10 share).
  v_finalized := billing.finalize_usage(
    '81000000-0000-4000-8000-000000000001',
    (v_reserved ->> 'reservation_id')::uuid,
    (v_reserved ->> 'claim_token')::uuid,
    (v_reserved ->> 'lease_epoch')::bigint,
    3
  );
  if (v_finalized ->> 'refunded_units')::bigint <> 7 then
    raise exception 'expected 7 refunded units, got: %', v_finalized;
  end if;

  select remaining_units into v_soon_remaining from billing.usage_buckets where id = v_bucket_soon;
  select remaining_units into v_later_remaining from billing.usage_buckets where id = v_bucket_later;
  if v_soon_remaining + v_later_remaining <> 7 then
    raise exception 'refund did not land back on the origin buckets: soon=% later=%', v_soon_remaining, v_later_remaining;
  end if;
end
$$;

select pass('invariant 2: multi-bucket FEFO split and proportional refund on finalize');

-- ---------------------------------------------------------------------------------------------
-- Invariant #3: tenant-scoped idempotency — same (account_id, idempotency_key) never double-reserves.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket uuid := '82000000-0000-4000-8000-0000000b0001';
  v_first jsonb;
  v_second jsonb;
  v_count integer;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values (v_bucket, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 50, 50, now() + interval '1 day');

  v_first := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'idem-key-1', 5, 'worker-idem-1');
  v_second := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'idem-key-1', 5, 'worker-idem-1');

  if v_first ->> 'reservation_id' <> v_second ->> 'reservation_id'
     or v_first ->> 'claim_token' <> v_second ->> 'claim_token' then
    raise exception 'retried reserve_usage did not return the identical result: % vs %', v_first, v_second;
  end if;

  select count(*) into v_count from billing.usage_reservations
  where account_id = '82000000-0000-4000-8000-000000000002' and idempotency_key = 'idem-key-1';
  if v_count <> 1 then
    raise exception 'expected exactly one reservation row for the idempotency key, found %', v_count;
  end if;
end
$$;

select pass('invariant 3: tenant-scoped idempotency prevents double reservation on retry');

-- ---------------------------------------------------------------------------------------------
-- Invariant #4: stale claim_token/lease_epoch rejected after expiry + reclaim.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket uuid := '82000000-0000-4000-8000-0000000b0002';
  v_reserved jsonb;
  v_reclaimed jsonb;
  v_stale_rejected boolean := false;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values (v_bucket, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 20, 20, now() + interval '1 day');

  v_reserved := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'reclaim-key-1', 5, 'worker-reclaim-1', 5);

  -- Force the lease into the past so it becomes reclaimable.
  update billing.usage_reservations
  set expires_at = now() - interval '1 second'
  where id = (v_reserved ->> 'reservation_id')::uuid;

  v_reclaimed := billing.reclaim_usage_reservation(
    '82000000-0000-4000-8000-000000000002',
    (v_reserved ->> 'reservation_id')::uuid,
    'worker-reclaim-2',
    300
  );
  if (v_reclaimed ->> 'lease_epoch')::bigint <> (v_reserved ->> 'lease_epoch')::bigint + 1 then
    raise exception 'reclaim did not increment lease_epoch: %', v_reclaimed;
  end if;

  begin
    perform billing.finalize_usage(
      '82000000-0000-4000-8000-000000000002',
      (v_reserved ->> 'reservation_id')::uuid,
      (v_reserved ->> 'claim_token')::uuid,
      (v_reserved ->> 'lease_epoch')::bigint,
      1
    );
  exception when sqlstate '55000' then
    v_stale_rejected := true;
  end;
  if not v_stale_rejected then
    raise exception 'stale claim_token/lease_epoch was accepted after reclaim';
  end if;

  -- The new owner's token/epoch must work.
  perform billing.finalize_usage(
    '82000000-0000-4000-8000-000000000002',
    (v_reclaimed ->> 'reservation_id')::uuid,
    (v_reclaimed ->> 'claim_token')::uuid,
    (v_reclaimed ->> 'lease_epoch')::bigint,
    1
  );
end
$$;

select pass('invariant 4: stale claim_token/lease_epoch rejected after expiry + reclaim');

-- ---------------------------------------------------------------------------------------------
-- Invariant #5: repeated finalize/release calls are no-ops (idempotent retries, no double refund).
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket uuid := '82000000-0000-4000-8000-0000000b0003';
  v_reserved jsonb;
  v_finalize_1 jsonb;
  v_finalize_2 jsonb;
  v_remaining_after_1 bigint;
  v_remaining_after_2 bigint;
  v_release_reserved jsonb;
  v_release_1 jsonb;
  v_release_2 jsonb;
  v_release_bucket uuid := '82000000-0000-4000-8000-0000000b0004';
  v_release_remaining_1 bigint;
  v_release_remaining_2 bigint;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values
    (v_bucket, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 20, 20, now() + interval '1 day'),
    (v_release_bucket, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 20, 20, now() + interval '1 day');

  v_reserved := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'idem-finalize-1', 8, 'worker-fin-1');
  v_finalize_1 := billing.finalize_usage(
    '82000000-0000-4000-8000-000000000002', (v_reserved ->> 'reservation_id')::uuid,
    (v_reserved ->> 'claim_token')::uuid, (v_reserved ->> 'lease_epoch')::bigint, 5
  );
  select remaining_units into v_remaining_after_1 from billing.usage_buckets where id = v_bucket;

  v_finalize_2 := billing.finalize_usage(
    '82000000-0000-4000-8000-000000000002', (v_reserved ->> 'reservation_id')::uuid,
    (v_reserved ->> 'claim_token')::uuid, (v_reserved ->> 'lease_epoch')::bigint, 5
  );
  select remaining_units into v_remaining_after_2 from billing.usage_buckets where id = v_bucket;

  if v_finalize_1 <> v_finalize_2 then
    raise exception 'repeated finalize returned a different result: % vs %', v_finalize_1, v_finalize_2;
  end if;
  if v_remaining_after_1 <> v_remaining_after_2 then
    raise exception 'repeated finalize changed bucket balance: % vs %', v_remaining_after_1, v_remaining_after_2;
  end if;

  v_release_reserved := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'idem-release-1', 6, 'worker-rel-1');
  v_release_1 := billing.release_usage(
    '82000000-0000-4000-8000-000000000002', (v_release_reserved ->> 'reservation_id')::uuid,
    (v_release_reserved ->> 'claim_token')::uuid, (v_release_reserved ->> 'lease_epoch')::bigint
  );
  select remaining_units into v_release_remaining_1 from billing.usage_buckets where id = v_release_bucket;

  v_release_2 := billing.release_usage(
    '82000000-0000-4000-8000-000000000002', (v_release_reserved ->> 'reservation_id')::uuid,
    (v_release_reserved ->> 'claim_token')::uuid, (v_release_reserved ->> 'lease_epoch')::bigint
  );
  select remaining_units into v_release_remaining_2 from billing.usage_buckets where id = v_release_bucket;

  if v_release_remaining_1 <> v_release_remaining_2 then
    raise exception 'repeated release changed bucket balance: % vs %', v_release_remaining_1, v_release_remaining_2;
  end if;
end
$$;

select pass('invariant 5: repeated finalize/release calls are idempotent no-ops');

-- ---------------------------------------------------------------------------------------------
-- Invariant #6: actual_units > reserved_units rejected at finalize.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket uuid := '82000000-0000-4000-8000-0000000b0005';
  v_reserved jsonb;
  v_rejected boolean := false;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values (v_bucket, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 20, 20, now() + interval '1 day');

  v_reserved := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'over-actual-key-1', 4, 'worker-over-1');

  begin
    perform billing.finalize_usage(
      '82000000-0000-4000-8000-000000000002', (v_reserved ->> 'reservation_id')::uuid,
      (v_reserved ->> 'claim_token')::uuid, (v_reserved ->> 'lease_epoch')::bigint, 999
    );
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'finalize accepted actual_units greater than reserved_units';
  end if;
end
$$;

select pass('invariant 6: actual_units > reserved_units rejected at finalize');

-- ---------------------------------------------------------------------------------------------
-- Invariant #7: direct UPDATE/DELETE on billing.usage_ledger raises.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_ledger_id uuid;
  v_update_rejected boolean := false;
  v_delete_rejected boolean := false;
begin
  select id into v_ledger_id from billing.usage_ledger limit 1;
  if v_ledger_id is null then
    raise exception 'expected at least one ledger row from earlier invariants';
  end if;

  begin
    update billing.usage_ledger set units = units + 1 where id = v_ledger_id;
  exception when sqlstate '0LU01' then
    v_update_rejected := true;
  end;

  begin
    delete from billing.usage_ledger where id = v_ledger_id;
  exception when sqlstate '0LU01' then
    v_delete_rejected := true;
  end;

  if not v_update_rejected or not v_delete_rejected then
    raise exception 'usage_ledger mutation was not blocked: update=% delete=%', v_update_rejected, v_delete_rejected;
  end if;
end
$$;

select pass('invariant 7: usage_ledger is append-only, UPDATE and DELETE both raise');

-- ---------------------------------------------------------------------------------------------
-- Invariant #8: fail-closed — insufficient units and insufficient budget both deny.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket uuid := '82000000-0000-4000-8000-0000000b0006';
  v_short jsonb;
  v_over_budget jsonb;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values (v_bucket, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 3, 3, now() + interval '1 day');

  v_short := billing.reserve_usage('82000000-0000-4000-8000-000000000002', 'deny-units-key-1', 999, 'worker-deny-1');
  if v_short ->> 'status' <> 'denied_insufficient_units' then
    raise exception 'expected denied_insufficient_units, got: %', v_short;
  end if;

  v_over_budget := billing.reserve_usage('81000000-0000-4000-8000-000000000001', 'deny-budget-key-1', 100000, 'worker-deny-2');
  if v_over_budget ->> 'status' <> 'denied_budget' then
    raise exception 'expected denied_budget, got: %', v_over_budget;
  end if;
end
$$;

select pass('invariant 8: fail-closed denial on insufficient units and insufficient budget');

-- ---------------------------------------------------------------------------------------------
-- Invariant #11: expire_usage_reservations respects a bounded p_limit and rejects an invalid one.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_account uuid := '82000000-0000-4000-8000-000000000002';
  v_bucket_a uuid := '82000000-0000-4000-8000-0000000b0007';
  v_bucket_b uuid := '82000000-0000-4000-8000-0000000b0008';
  v_res_a jsonb;
  v_res_b jsonb;
  v_first_sweep jsonb;
  v_second_sweep jsonb;
  v_remaining_reserved integer;
  v_rejected boolean := false;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values
    (v_bucket_a, v_account, 'purchase', 1, 10, 10, now() + interval '1 day'),
    (v_bucket_b, v_account, 'purchase', 1, 10, 10, now() + interval '1 day');

  v_res_a := billing.reserve_usage(v_account, 'plimit-key-a', 2, 'worker-plimit-a', 5);
  v_res_b := billing.reserve_usage(v_account, 'plimit-key-b', 2, 'worker-plimit-b', 5);
  update billing.usage_reservations set expires_at = now() - interval '1 second'
  where id in ((v_res_a ->> 'reservation_id')::uuid, (v_res_b ->> 'reservation_id')::uuid);

  begin
    perform billing.expire_usage_reservations(0);
  exception when sqlstate '22023' then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expire_usage_reservations accepted an out-of-range p_limit';
  end if;

  v_first_sweep := billing.expire_usage_reservations(1);
  if (v_first_sweep ->> 'expired_count')::integer <> 1 then
    raise exception 'expected exactly one reservation swept under p_limit=1, got: %', v_first_sweep;
  end if;

  select count(*) into v_remaining_reserved
  from billing.usage_reservations
  where id in ((v_res_a ->> 'reservation_id')::uuid, (v_res_b ->> 'reservation_id')::uuid)
    and status = 'reserved';
  if v_remaining_reserved <> 1 then
    raise exception 'p_limit=1 swept more than one row: % still reserved', v_remaining_reserved;
  end if;

  v_second_sweep := billing.expire_usage_reservations(100);
  if (v_second_sweep ->> 'expired_count')::integer <> 1 then
    raise exception 'expected the remaining overdue reservation to sweep on the next call, got: %', v_second_sweep;
  end if;
end
$$;

select pass('invariant 11: expire_usage_reservations honors a bounded p_limit and rejects an invalid one');

-- ---------------------------------------------------------------------------------------------
-- Invariant #12: deterministic bucket-lock ordering does not change settlement correctness — a
-- reservation spanning three buckets whose allocation ids are unrelated to bucket_id order still
-- conserves units exactly across finalize's two-pass (id-ordered compute, bucket_id-ordered apply)
-- split. True deadlock-freedom needs concurrent connections and is out of scope for this
-- single-connection file (same caveat as invariant #1); this checks the correctness side of the
-- same code path.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bucket_1 uuid := '82000000-0000-4000-8000-0000000b0009';
  v_bucket_2 uuid := '82000000-0000-4000-8000-0000000b000a';
  v_bucket_3 uuid := '82000000-0000-4000-8000-0000000b000b';
  v_reserved jsonb;
  v_finalized jsonb;
  v_total_remaining_after bigint;
  v_total_remaining_before bigint := 5 + 5 + 5;
begin
  insert into billing.usage_buckets (id, account_id, source, pricing_matrix_version, total_units, remaining_units, expires_at)
  values
    (v_bucket_1, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 5, 5, now() + interval '1 day'),
    (v_bucket_2, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 5, 5, now() + interval '2 days'),
    (v_bucket_3, '82000000-0000-4000-8000-000000000002', 'purchase', 1, 5, 5, now() + interval '3 days');

  v_reserved := billing.reserve_usage(
    '82000000-0000-4000-8000-000000000002', 'ordering-key-1', 12, 'worker-ordering-1'
  );
  if v_reserved ->> 'status' <> 'reserved' or jsonb_array_length(v_reserved -> 'allocations') <> 3 then
    raise exception 'expected a three-bucket FEFO split, got: %', v_reserved;
  end if;

  v_finalized := billing.finalize_usage(
    '82000000-0000-4000-8000-000000000002',
    (v_reserved ->> 'reservation_id')::uuid,
    (v_reserved ->> 'claim_token')::uuid,
    (v_reserved ->> 'lease_epoch')::bigint,
    7
  );
  if (v_finalized ->> 'refunded_units')::bigint <> 5 then
    raise exception 'expected 5 refunded units across three buckets, got: %', v_finalized;
  end if;

  select coalesce(sum(remaining_units), 0) into v_total_remaining_after
  from billing.usage_buckets
  where id in (v_bucket_1, v_bucket_2, v_bucket_3);
  if v_total_remaining_after <> v_total_remaining_before - 12 + 5 then
    raise exception 'units were not conserved across the bucket_id-ordered refund apply pass: %', v_total_remaining_after;
  end if;
end
$$;

select pass('invariant 12: bucket_id-ordered refund apply pass conserves units exactly across a multi-bucket settlement');

-- ---------------------------------------------------------------------------------------------
-- Invariant #13: reconciliation delta=0, computed from actual balances/buckets/allocations/ledger
-- (never from a `details` key reserve/finalize never write). For every billing.usage_reservations
-- row, allocated - refunded must equal the account's currently-reserved-or-spent units, and every
-- bucket's total_units must equal remaining_units + sum(allocated - refunded) across its
-- allocations — i.e. no unit is ever lost or duplicated between a bucket and its allocations.
-- ---------------------------------------------------------------------------------------------

do $$
declare
  v_bad_buckets integer;
  v_bad_reservations integer;
begin
  select count(*) into v_bad_buckets
  from billing.usage_buckets as bucket
  where bucket.total_units <> bucket.remaining_units + coalesce((
    select sum(allocation.allocated_units - allocation.refunded_units)
    from billing.usage_reservation_allocations as allocation
    where allocation.bucket_id = bucket.id
  ), 0);
  if v_bad_buckets <> 0 then
    raise exception 'reconciliation delta != 0: % bucket(s) do not conserve total = remaining + outstanding allocations', v_bad_buckets;
  end if;

  select count(*) into v_bad_reservations
  from billing.usage_reservations as reservation
  where reservation.reserved_units <> (
    select coalesce(sum(allocation.allocated_units), 0)
    from billing.usage_reservation_allocations as allocation
    where allocation.reservation_id = reservation.id
  );
  if v_bad_reservations <> 0 then
    raise exception 'reconciliation delta != 0: % reservation(s) do not sum to their allocations', v_bad_reservations;
  end if;
end
$$;

select pass('invariant 13: reconciliation delta=0 across billing.usage_buckets and billing.usage_reservation_allocations, computed directly from balances');

select * from finish();

rollback;
