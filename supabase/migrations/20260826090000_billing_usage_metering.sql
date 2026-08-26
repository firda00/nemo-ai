-- ADR 003: usage metering, FEFO reservations and append-only ledger.
-- Closed schema: every table is unreachable except through the security-definer RPCs below.

create schema billing;
revoke all on schema billing from public, anon, authenticated;
grant usage on schema billing to service_role;

-- ---------------------------------------------------------------------------------------------
-- billing.pricing_matrices
-- ---------------------------------------------------------------------------------------------

create table billing.pricing_matrices (
  id uuid primary key default gen_random_uuid(),
  version integer not null,
  name text not null,
  conversion_rules jsonb not null default '{}'::jsonb,
  effective_from timestamptz not null default clock_timestamp(),
  effective_until timestamptz,
  is_active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  constraint pricing_matrices_version_key unique (version),
  constraint pricing_matrices_account_id_id_key unique (id),
  constraint pricing_matrices_version_check check (version > 0),
  constraint pricing_matrices_name_check check (char_length(name) between 1 and 160),
  constraint pricing_matrices_rules_type_check check (jsonb_typeof(conversion_rules) = 'object'),
  -- 32 KiB bound: these payloads are small structured rule sets, not agent output; see ADR 003 §3.7.
  constraint pricing_matrices_rules_size_check check (octet_length(conversion_rules::text) <= 32768),
  constraint pricing_matrices_window_check check (
    effective_until is null or effective_until > effective_from
  )
);

-- Only one active matrix at a time: admission always snapshots exactly one unambiguous version.
create unique index pricing_matrices_single_active_idx
  on billing.pricing_matrices ((true))
  where is_active;

revoke all on billing.pricing_matrices from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.account_usage_policies
-- ---------------------------------------------------------------------------------------------

create table billing.account_usage_policies (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  pricing_matrix_version integer not null references billing.pricing_matrices (version),
  budget_units bigint not null,
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint account_usage_policies_account_key unique (account_id),
  constraint account_usage_policies_account_id_id_key unique (account_id, id),
  constraint account_usage_policies_budget_check check (budget_units > 0),
  constraint account_usage_policies_policy_type_check check (jsonb_typeof(policy) = 'object'),
  constraint account_usage_policies_policy_size_check check (octet_length(policy::text) <= 32768)
);

revoke all on billing.account_usage_policies from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.usage_buckets — FEFO-consumed purchased/granted compute-unit buckets
-- ---------------------------------------------------------------------------------------------

create table billing.usage_buckets (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  source text not null,
  pricing_matrix_version integer not null references billing.pricing_matrices (version),
  total_units bigint not null,
  remaining_units bigint not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_buckets_account_id_id_key unique (account_id, id),
  constraint usage_buckets_source_check check (
    source in ('purchase', 'grant', 'promo', 'legacy_migration')
  ),
  constraint usage_buckets_total_check check (total_units > 0),
  constraint usage_buckets_remaining_check check (
    remaining_units >= 0 and remaining_units <= total_units
  )
);

create index usage_buckets_fefo_idx
  on billing.usage_buckets (account_id, expires_at, id)
  where remaining_units > 0;

revoke all on billing.usage_buckets from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.usage_reservations
-- ---------------------------------------------------------------------------------------------

create table billing.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  idempotency_key text not null,
  claim_token uuid not null default gen_random_uuid(),
  lease_epoch bigint not null default 0,
  owner_token text not null,
  status text not null default 'reserved',
  reserved_units bigint not null,
  actual_units bigint,
  policy_snapshot jsonb not null default '{}'::jsonb,
  result jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  finalized_at timestamptz,
  released_at timestamptz,
  constraint usage_reservations_account_id_id_key unique (account_id, id),
  constraint usage_reservations_idempotency_key unique (account_id, idempotency_key),
  constraint usage_reservations_status_check check (
    status in ('reserved', 'finalized', 'released', 'expired')
  ),
  constraint usage_reservations_idempotency_shape_check check (
    char_length(idempotency_key) between 1 and 200
  ),
  constraint usage_reservations_owner_token_check check (
    char_length(owner_token) between 1 and 200
  ),
  constraint usage_reservations_reserved_check check (reserved_units > 0),
  constraint usage_reservations_actual_check check (
    actual_units is null or (actual_units >= 0 and actual_units <= reserved_units)
  ),
  constraint usage_reservations_lease_epoch_check check (lease_epoch >= 0),
  constraint usage_reservations_snapshot_type_check check (
    jsonb_typeof(policy_snapshot) = 'object'
  ),
  constraint usage_reservations_snapshot_size_check check (
    octet_length(policy_snapshot::text) <= 32768
  ),
  constraint usage_reservations_result_type_check check (
    result is null or jsonb_typeof(result) = 'object'
  ),
  constraint usage_reservations_result_size_check check (
    result is null or octet_length(result::text) <= 32768
  ),
  constraint usage_reservations_terminal_check check (
    (status = 'reserved' and finalized_at is null and released_at is null)
    or (status = 'finalized' and finalized_at is not null)
    or (status in ('released', 'expired') and released_at is not null)
  )
);

create index usage_reservations_expiry_idx
  on billing.usage_reservations (account_id, expires_at, id)
  where status = 'reserved';

revoke all on billing.usage_reservations from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- billing.usage_reservation_allocations — one reservation, FEFO-split across many buckets
-- ---------------------------------------------------------------------------------------------

create table billing.usage_reservation_allocations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  reservation_id uuid not null,
  bucket_id uuid not null,
  allocated_units bigint not null,
  refunded_units bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_reservation_allocations_account_id_id_key unique (account_id, id),
  constraint usage_reservation_allocations_reservation_fkey
    foreign key (account_id, reservation_id)
    references billing.usage_reservations (account_id, id) on delete cascade,
  constraint usage_reservation_allocations_bucket_fkey
    foreign key (account_id, bucket_id)
    references billing.usage_buckets (account_id, id) on delete restrict,
  constraint usage_reservation_allocations_units_check check (allocated_units > 0),
  constraint usage_reservation_allocations_refund_check check (
    refunded_units >= 0 and refunded_units <= allocated_units
  )
);

create index usage_reservation_allocations_reservation_idx
  on billing.usage_reservation_allocations (account_id, reservation_id);
create index usage_reservation_allocations_bucket_idx
  on billing.usage_reservation_allocations (account_id, bucket_id);

revoke all on billing.usage_reservation_allocations from public, anon, authenticated;

-- The parent-sum invariant ("reserved_units = sum(allocations.allocated_units)") is cross-row and
-- cannot be a CHECK constraint (see ADR 003 §3.5). reserve_usage always inserts a reservation's
-- full allocation set in a single multi-row INSERT, so a statement-level trigger reading the
-- transition table sees the complete set exactly once per reservation.
create function billing.check_allocation_sum()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_expected bigint;
begin
  for r in
    select new_rows.reservation_id as reservation_id, sum(new_rows.allocated_units) as total
    from new_rows
    group by new_rows.reservation_id
  loop
    select reservation.reserved_units into strict v_expected
    from billing.usage_reservations as reservation
    where reservation.id = r.reservation_id;
    if r.total is distinct from v_expected then
      raise exception using errcode = '0LU02',
        message = 'allocation sum does not match reservation.reserved_units';
    end if;
  end loop;
  return null;
end
$$;

create trigger usage_reservation_allocations_sum_check
  after insert on billing.usage_reservation_allocations
  referencing new table as new_rows
  for each statement
  execute function billing.check_allocation_sum();

-- ---------------------------------------------------------------------------------------------
-- billing.usage_ledger — append-only audit trail
-- ---------------------------------------------------------------------------------------------

create table billing.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  event_type text not null,
  units bigint not null,
  reservation_id uuid,
  bucket_id uuid,
  idempotency_key text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint usage_ledger_event_type_check check (
    event_type in ('reserve', 'finalize', 'refund', 'release', 'expire', 'grant')
  ),
  -- >= 0, not > 0: a finalize event may legitimately record zero actual units (fully refunded).
  constraint usage_ledger_units_check check (units >= 0),
  constraint usage_ledger_details_type_check check (jsonb_typeof(details) = 'object'),
  constraint usage_ledger_details_size_check check (octet_length(details::text) <= 32768),
  constraint usage_ledger_reservation_fkey
    foreign key (account_id, reservation_id)
    references billing.usage_reservations (account_id, id) on delete restrict,
  constraint usage_ledger_bucket_fkey
    foreign key (account_id, bucket_id)
    references billing.usage_buckets (account_id, id) on delete restrict
);

create index usage_ledger_account_idx on billing.usage_ledger (account_id, created_at, id);
create index usage_ledger_reservation_idx on billing.usage_ledger (account_id, reservation_id);

revoke all on billing.usage_ledger from public, anon, authenticated;

create function billing.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '0LU01', message = 'usage_ledger is append-only';
end
$$;

create trigger usage_ledger_immutable
  before update or delete on billing.usage_ledger
  for each row execute function billing.prevent_ledger_mutation();

-- ---------------------------------------------------------------------------------------------
-- billing.cutover_state — GLOBAL, one-way admission gate. Neither billing.reserve_usage nor the
-- patched public.reserve_token_usage may ever both admit the same unit of work: before activation
-- only legacy admits (v2_active = false), after a successful billing.activate_global_cutover only
-- v2 admits. This is deliberately a single singleton row, not a per-account flag — a per-account
-- cutover would let two admission routes both be "correct" for different accounts at once, which is
-- exactly the dual-admission risk this table exists to close off. See ADR 003 §5.
-- ---------------------------------------------------------------------------------------------

create table billing.cutover_state (
  singleton boolean primary key default true,
  v2_active boolean not null default false,
  activated_by text,
  reason_code text,
  activated_at timestamptz,
  cutover_epoch bigint not null default 0,
  constraint cutover_state_singleton_check check (singleton),
  constraint cutover_state_epoch_check check (cutover_epoch >= 0),
  constraint cutover_state_activation_check check (
    (not v2_active and activated_by is null and reason_code is null and activated_at is null)
    or (v2_active and activated_by is not null and reason_code is not null and activated_at is not null)
  ),
  constraint cutover_state_reason_check check (
    reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint cutover_state_actor_check check (
    activated_by is null or char_length(activated_by) between 1 and 160
  )
);

insert into billing.cutover_state (singleton) values (true);

revoke all on billing.cutover_state from public, anon, authenticated;

comment on table billing.cutover_state is
  'Global, one-way v2 admission gate. Never per-account: exactly one of legacy/v2 may admit at a time.';

comment on table billing.pricing_matrices is
  'Versioned pricing/unit-conversion rules. Admission always snapshots a specific version.';
comment on table billing.account_usage_policies is
  'Per-account budget referencing a pricing_matrices version by value, not a live pointer.';
comment on table billing.usage_buckets is
  'Purchased/granted compute-unit capacity, FEFO-consumed by expires_at.';
comment on table billing.usage_reservations is
  'Fenced reservations: claim_token + lease_epoch gate every state transition.';
comment on table billing.usage_reservation_allocations is
  'FEFO split of one reservation across one or more buckets.';
comment on table billing.usage_ledger is
  'Append-only event trail; mutation is blocked by trigger, not just convention.';
