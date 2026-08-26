# ADR 003: Usage Metering, Reservation Safety, and Drain-First Legacy Cutover

**Status:** Proposed
**Date:** 2026-08-26
**Deciders:** Core Engineering Team
**Consulted:** Security, Billing/Finance, Infrastructure
**Informed:** Product, Executive Team
**Supercedes / Depends on:** ADR 001 (Durable Operations Runtime), ADR 002 (Execution Sandbox and
Multimodal); replaces `public.token_usage_reservations` as the system of record going forward.

---

## 1. Core Architectural Invariant

> **The Fail-Closed Metering Invariant:**
> No unit of compute may be attributed to an account faster than it is admitted, and no admitted
> unit may be spent twice. Every reservation is fenced by a `claim_token`/`lease_epoch` pair, every
> balance mutation happens inside the same row lock that read the balance, and every terminal state
> transition (`finalize`/`release`/`expire`) is idempotent under retry.

The legacy `public.token_usage_reservations` system deducts `accounts.token_balance` directly at
reserve time with no concept of FEFO-ordered purchased capacity, no lease fencing beyond a single
`claim_token` column, and — critically — no `runtime.system_controls` kill-switch check on the
admission path. This ADR introduces a new, closed `billing` schema that generalizes reservations
into **FEFO-consumed usage buckets** or, and defines a **drain-first** cutover so the legacy system
can be retired without a stop-the-world migration or any window of double-charging.

---

## 2. Why Not Extend the Legacy Table

`token_usage_reservations` conflates three concerns that need to be separable for a real
usage-based billing product: (1) how many compute units an account owns and when they expire —
today just a single scalar `accounts.token_balance`; (2) reservation/lease fencing for concurrent
workers; (3) an audit trail. Adding purchased-bucket semantics (FEFO expiry, multiple funding
sources — subscription grant, top-up purchase, promo) to the existing table would require an
incompatible schema change under an FK the legacy RPCs already depend on. A new schema lets the two
systems run side by side during drain, and lets us delete the legacy path later with a single
documented manual step instead of a blocking migration.

---

## 3. Schema (`billing`, `billing_legacy`)

Both schemas are **closed**: `revoke all on schema ... from public, anon, authenticated;` then
`grant usage on schema ... to service_role;`. All tables additionally `revoke all ... from public,
anon, authenticated`. All reads and writes go through `security definer` RPCs with
`set search_path = ''`; the service role does not need direct table grants because every legitimate
caller (Edge Functions, workers) calls the RPCs, not the tables. We keep the tables completely
closed rather than granting `service_role` row access directly, so that a future bug in an Edge
Function cannot bypass the fencing/idempotency logic by issuing raw DML — this mirrors the ADR 001
circuit-breaker pattern where the runtime tables are unreachable except via the RPC surface.

### 3.1 `billing.pricing_matrices`

Versioned pricing/unit-conversion table. `version` is the stable handle other tables snapshot.
`conversion_rules` documents, among other things, the legacy-credit-to-compute-unit factor used by
the drain cutover (`legacy_credit_to_unit`). Only one row may be `is_active` at a time (partial
unique index), and `effective_from`/`effective_until` bound its validity window.

### 3.2 `billing.account_usage_policies`

Per-account budget referencing a `pricing_matrices` **version**, not a live foreign key — the
version is copied verbatim (a `policy_snapshot` jsonb) into every reservation created against that
policy so that budget admission is auditable against exactly the rule set that was live at the
time, even if the matrix is superseded a millisecond later. This is a deliberate business
requirement in the task brief ("snapshot, not live re-lookup"), and prevents a matrix edit from
silently reinterpreting historical admission decisions.

### 3.3 `billing.usage_buckets`

Purchased/granted compute-unit buckets. `remaining_units` is decremented at reservation time and
incremented on refund (unused-on-finalize, full-on-release/expire). FEFO consumption orders by
`expires_at` ascending. `source` distinguishes `purchase`, `grant`, `promo`, and
`legacy_migration` (the one-time bucket created per account by the global cutover, §5).

### 3.4 `billing.usage_reservations`

One row per admitted reservation. `claim_token` + `lease_epoch` are the fencing pair (mirrors
`runtime.workflow_runs`). `owner_token` identifies the logical caller (run id / worker id) for
observability; ownership enforcement itself is by `claim_token`+`lease_epoch`, not `owner_token`,
so a crashed worker cannot be impersonated by guessing an owner string. `unique(account_id,
idempotency_key)` gives tenant-scoped idempotency: a retried `reserve_usage` call with the same key
returns the original result instead of allocating twice.

### 3.5 `billing.usage_reservation_allocations`

A reservation may FEFO-split across multiple buckets. Each allocation composite-FKs to both parents
scoped by `account_id`: `(account_id, reservation_id) references billing.usage_reservations
(account_id, id)` and `(account_id, bucket_id) references billing.usage_buckets(account_id, id)`.
This is the standard tenant-composite-FK pattern used across the codebase (e.g.
`compute_jobs_workflow_fkey`): it makes a cross-tenant reference structurally impossible, not just
application-checked.

**Invariant "sum(allocations.allocated_units) = reservation.reserved_units" cannot be a plain
`CHECK`** because a `CHECK` constraint only sees one row and this is a cross-row aggregate. It is
enforced by an `AFTER INSERT ... REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT` trigger that
sums the allocation rows just inserted (per `reservation_id`, within that statement's transition
table) and compares the total against the parent's `reserved_units`. `reserve_usage` always inserts
all of a reservation's allocations in one multi-row `INSERT`, so the statement-level transition
table always contains the complete allocation set for that reservation, and the trigger fires
exactly once per reservation creation. Rows are never allocated in more than one INSERT statement.

### 3.6 `billing.usage_ledger`

Append-only audit trail: `reserve`, `finalize`, `refund`, `release`, `expire`, `grant` (the last one
used only by the drain cutover). A `BEFORE UPDATE OR DELETE` trigger raises `errcode '0LU01'`
(`usage_ledger is append-only`) unconditionally — there is no privileged bypass; corrections are new
compensating rows, matching how `runtime.audit_events`-style tables are treated elsewhere in this
codebase.

### 3.7 JSON and numeric bounds

Every `jsonb` column has `check (jsonb_typeof(col) = 'object')` and
`check (octet_length(col::text) <= 32768)`. 32 KiB is the same bound already used implicitly by
`finalize_token_usage`'s `p_result` cap (50000 there; we tightened to 32 KiB here because these
payloads are policy/allocation snapshots, not arbitrary agent output, and 32 KiB is comfortably
larger than the largest realistic snapshot — a handful of allocations plus a policy version). Units
columns use `check (... > 0)` for anything that must be strictly positive (`reserved_units`,
`allocated_units`, `total_units`) and `check (... >= 0)` for anything that can legitimately reach
zero (`remaining_units`, `refunded_units`).

---

## 4. RPCs

All RPCs are `security definer`, `set search_path = ''`, validate every input with
`raise exception using errcode = '22023'` (invalid textual input) style guards before touching any
row, and are `revoke all ... from public, anon, authenticated; grant execute ... to service_role;`.

### 4.1 `billing.reserve_usage`

1. Validates inputs (`p_units > 0`, TTL bounds, key length/shape).
2. Reads `runtime.system_controls` `for share` and denies (`status = 'denied_kill_switch'`) if
   `kill_switch_active` or `claims_paused` — the same fail-closed pattern as
   `public.runtime_claim_workflow`, applied to the new admission path so a future kill-switch flip
   stops both runtimes at once.
3. Reads `billing.cutover_state` `for share` and denies (`status = 'denied_cutover_inactive'`)
   unless `v2_active` — see §5. This is checked before the account is touched at all, so a
   pre-activation call never even attempts the per-account lock in the next step.
4. Locks `billing.account_usage_policies` for the account `for update` — **before** the idempotency
   lookup and the outstanding-budget calculation, not after. This single lock is what serializes all
   concurrent `reserve_usage` calls for one account: a second caller with the same
   `idempotency_key` cannot reach the idempotency `SELECT` until the first caller's `INSERT` has
   committed (or is still ahead of it holding the lock), which is what makes concurrent identical
   keys replay the same reservation instead of racing a `unique_violation`; and no two concurrent
   callers can read the same "outstanding" total and both admit past `budget_units` (invariant #1's
   distinct-keys case). No policy row -> `status = 'denied_no_policy'`.
5. Looks up any existing `(account_id, idempotency_key)` row `for update`. If found, returns the
   stored result **unconditionally**, regardless of its current status — this is what makes retries
   safe (invariant #3) without a second code path.
6. Otherwise reads the `pricing_matrices` row at the policy's version (the snapshot), and computes
   budget headroom as `sum(reserved_units) of that account's currently 'reserved' rows + p_units <=
   budget_units`. Not enough headroom -> `status = 'denied_budget'` (fail-closed, invariant #8).
7. Locks candidate buckets `for update` (no `skip locked` — correctness here requires a
   deterministic fully-allocate-or-fail outcome, not "skip busy buckets"), ordered
   `expires_at asc, id asc`, `where remaining_units > 0 and expires_at > now()`. Walks the locked
   set accumulating `remaining_units` until it covers `p_units`. If total available capacity across
   all locked buckets is short, releases nothing (the locks simply commit unchanged) and returns
   `status = 'denied_insufficient_units'`.
8. On success: decrements each consumed bucket's `remaining_units`, inserts the reservation row,
   inserts one multi-row `INSERT` covering every allocation, inserts one `usage_ledger` row per
   allocation (`event_type = 'reserve'`), and returns `status = 'reserved'` with
   `claim_token`/`lease_epoch`/allocation breakdown.

Because step 7 takes a real row lock on each bucket (not `skip locked`), concurrent callers racing
for the same scarce bucket serialize on that lock: exactly as many succeed as the bucket has units
for, and the rest observe `remaining_units` already exhausted once they acquire the lock and get a
deterministic denial — this is what invariant #1 (20 parallel callers, 3 units, exactly 3 admits)
depends on. `finalize_usage`, `release_usage`, and `expire_usage_reservations` all take their bucket
locks in the same deterministic `bucket_id asc` order (never `id`/allocation order), so two
concurrent settlements that happen to share buckets across different reservations can never form a
lock-ordering deadlock cycle.

### 4.2 `billing.heartbeat_usage`

Validates `claim_token` **and** `lease_epoch` match the current row, reservation is `reserved` and
unexpired, then extends `expires_at`. Does **not** touch `lease_epoch` — heartbeats prove the same
owner is still alive; they do not represent a new claim.

### 4.3 `billing.finalize_usage`

Requires matching `claim_token` and `lease_epoch`, `status = 'reserved'`, unexpired. Rejects
`p_actual_units > reserved_units` (invariant #6) before mutating anything. Computes
`refund = reserved_units - actual_units`, splits it back across the reservation's allocations in
proportion to each allocation's share (largest-remainder rounding so the parts sum exactly to
`refund`, remainder assigned to the allocation ordered last by `id`), adds the refund back to each
allocation's origin bucket's `remaining_units` (buckets are credited even if since expired — the
capacity was already paid for and unused; the account should get it back regardless of whether the
*window* for consuming it separately elapsed mid-flight, since this is a return of the same
reservation, not a fresh admission), writes `finalize` and (if `refund > 0`) `refund` ledger rows,
and sets `status = 'finalized'`. If called again with `status` already `'finalized'`, returns the
stored result unchanged (invariant #5 — no double refund).

### 4.4 `billing.release_usage`

Same fencing. Refunds the **full** `reserved_units` back to the origin buckets, marks
`status = 'released'`, one `release` ledger row. Idempotent the same way as finalize.

### 4.5 `billing.expire_usage_reservations(p_limit)`

Bounded batch. `where status = 'reserved' and expires_at <= now()`, `order by account_id,
expires_at, id`, `for update skip locked limit p_limit` — `skip locked` is safe here because
already-expired rows are independent of each other (unlike the FEFO admission path, there is no
"all or nothing" correctness requirement across rows in a batch expiry sweep). Refunds full units,
`expire` ledger rows, `status = 'expired'`.

### 4.6 Reclaim / lease-epoch increment

`billing.reclaim_usage_reservation(p_account_id, p_reservation_id, p_new_owner_token,
p_lease_seconds)` is a small dedicated RPC rather than folding reclaim into `reserve_usage`,
because reclaim is keyed by `reservation_id` (a worker recovering someone else's abandoned lease)
while `reserve_usage` is keyed by `idempotency_key` (a caller retrying its own call) — conflating
the two would mean a retry and a hostile-takeover share one code path, which is exactly the kind of
ambiguity that causes fencing bugs. It requires `status = 'reserved' and expires_at <= now()`
(lease actually expired — you cannot reclaim a live lease), increments `lease_epoch`, issues a new
`claim_token`, and resets `owner_token`/`expires_at`. Any caller still holding the old
`claim_token`/`lease_epoch` pair is rejected by every subsequent `heartbeat`/`finalize`/`release`
call once the epoch has moved (invariant #4).

---

## 5. Global Safe Drain-First Legacy Cutover

Admission routing between the legacy system and `billing` is governed by a single, environment-wide
gate: `billing.cutover_state`, a singleton row with one boolean, `v2_active`. Before activation, only
`public.reserve_token_usage` admits and `billing.reserve_usage` denies
(`status = 'denied_cutover_inactive'`); after a successful `billing.activate_global_cutover`, the
reverse holds (`public.reserve_token_usage` returns `status = 'denied_cutover_active'`) — never both
at once, and never a state where a decision depends on which account is asking. This replaces an
earlier draft of this ADR that proposed gating admission **per account** (via presence of a
`billing_legacy.drain_snapshots` row for that specific account); that per-account-authoritative
design was **not approved** and is not implemented. A per-account routing decision means two
different admission answers can be simultaneously "correct" in the same environment depending on
which account is asking, which is exactly the kind of ambiguity the Fail-Closed Metering Invariant
(§1) rules out — routing correctness has to be a property of the whole environment, not a per-row
lookup that every future admission path must also remember to check.

- **Global, gated by an explicit maintenance window, snapshotted in one transaction.** A cutover
  first requires the caller to put the system into maintenance via the new
  `runtime.enter_billing_maintenance(p_actor, p_reason_code)` RPC (`claims_paused = true` **and**
  `ingestion_paused = true`, with `reason_code`/`activated_by`/`activated_at` all set — the existing
  `system_controls_activation_check` constraint enforces that the metadata triple is present
  whenever any flag is on). `billing.activate_global_cutover(p_actor, p_reason_code)` then verifies
  that precondition, additionally requires `kill_switch_active = false` (§7.3), verifies
  `billing_legacy.quad_zero_check()` reports all four counts as exactly zero, and only then
  snapshots **every account** — locked in ascending `account_id` order, in the
  single transaction the function body runs in — before atomically clearing the maintenance
  flags/metadata (same shape as `runtime.resume_from_maintenance`) and flipping
  `billing.cutover_state.v2_active = true`, incrementing both `system_controls.control_epoch` and
  `billing.cutover_state.cutover_epoch`. Because it is one transaction, a failure at any point (a
  missing active pricing matrix, a quad-zero count that turned non-zero mid-check) rolls back the
  entire snapshot — there is no partially-cutover state to reason about.
- **This ADR ships the function but never invokes it.** No migration calls
  `billing.activate_global_cutover`; running it against a real environment is a manual operator
  action, gated by a human first confirming `billing_legacy.quad_zero_check()` output for that
  specific environment, exactly as the legacy-revoke runbook below already was.
- `billing_legacy.drain_snapshots(account_id primary key, snapshotted_balance, granted_bucket_id,
  pricing_matrix_version, snapshotted_at)` — written once per account, in bulk, inside
  `activate_global_cutover`'s transaction; `granted_bucket_id` composite-FKs to
  `billing.usage_buckets(account_id, id)` (tenant-scoped, like every other composite FK in this
  schema) and is `NULL` for a zero-balance account (a `NULL` FK column is unenforced under Postgres's
  default `MATCH SIMPLE`, which is exactly the "no bucket to reference" case).
- Conversion from legacy `token_balance` credits to new `billing` compute units is **explicit**,
  never implicit 1:1: it goes through the active `pricing_matrices.conversion_rules
  ->> 'legacy_credit_to_unit'` factor, exactly like any other pricing decision, and creates one
  `billing.usage_buckets` row per funded account (`source = 'legacy_migration'`, `expires_at = now()
  + interval '12 months'`) plus one append-only `'grant'` ledger row.
- The legacy admission function `public.reserve_token_usage` is patched (`create or replace`,
  identical signature — every existing caller keeps working) to add both (a) the same
  `runtime.system_controls` fail-closed check used by `runtime_claim_workflow`, returning
  `status = 'denied_kill_switch'`, and (b) the `billing.cutover_state.v2_active` check, returning
  `status = 'denied_cutover_active'` once cutover has run — staying consistent with its existing
  `denied_balance`/`denied_quota` result contract instead of breaking callers that pattern-match on
  `status`.
- `runtime.enter_billing_maintenance(p_actor, p_reason_code)` is the atomic *entering* half of a
  maintenance transition: both parameters are validated (actor length, reason-code shape) and both
  are stored — there was previously no RPC for this at all (operators set the pause flags directly),
  which meant `activate_global_cutover`'s precondition had no validated, auditable way to be
  satisfied. It locks and reads `runtime.system_controls` first and **fails closed
  (`sqlstate '55000'`) if `kill_switch_active` is already true**, without touching any column, so a
  billing maintenance window can never silently overwrite an unrelated incident's
  `reason_code`/`activated_by`/`activated_at` (see §7.3).
- `runtime.resume_from_maintenance(p_actor, p_reason_code)` performs the atomic *clearing* half of
  a maintenance transition in one `UPDATE`: it sets `claims_paused`/`ingestion_paused` to `false`
  and nulls `reason_code`/`activated_by`/`activated_at` in the same statement that increments
  `control_epoch`. It **never writes `kill_switch_active`** and locks/reads the row first to fail
  closed (`sqlstate '55000'`) if `kill_switch_active` is already true, so a billing-maintenance
  resume can never be mistaken for — or accidentally used as — a way to clear the kill switch. The
  existing `system_controls_activation_check` constraint requires those three metadata columns to
  be null whenever every flag is `false`, so "clear metadata" and "record who resumed" cannot both
  be true of the same *row state* after resume. `runtime.audit_events` requires a tenant
  `account_id` and workflow-scoped `correlation_id`, so it cannot hold a control-plane action that
  is not scoped to any one tenant; `resume_from_maintenance` instead returns `{resumed_by,
  resume_reason_code, resumed_at, control_epoch}` to its caller (an operator-facing Edge Function)
  to log outside the tenant-scoped runtime tables — both parameters are used in that return, not
  dropped.
- `billing_legacy.expire_legacy_reservations(p_limit)` — service-role-only cleanup RPC,
  `security definer set search_path = ''`. Selects `token_usage_reservations` rows
  `where status = 'active' and expires_at <= now()`, `order by account_id, expires_at, id`,
  `for update skip locked limit p_limit`. Refunds `accounts.token_balance` **exactly once** by
  transitioning `status` to `'expired'` in the same statement as the refund (a single `UPDATE ...
  FROM` / CTE so there is no window between "read credits to refund" and "mark refunded" where a
  concurrent caller could double-refund), and locks the affected `accounts` rows in ascending
  `account_id` order (matching the `order by account_id` on the reservation scan) to avoid
  cross-transaction deadlocks with any other process that also locks accounts in account-id order.
- `billing_legacy.quad_zero_check()` is a **read-only** function (no writes, callable to check
  cutover readiness) returning a `jsonb` object with the four counts that must all be zero before a
  real environment-wide legacy retirement: `autonomous_run_checkpoints` non-terminal
  (`status in ('active','queued','running')` — the checkpoint status check constraint's terminal
  states are `completed`/`failed`/`cancelled`), `runtime.workflow_runs` non-terminal
  (`current_state not in ('completed','failed','denied','dead_letter','cancelled')`),
  `runtime.compute_jobs` `status in ('pending','running')`, and
  `public.token_usage_reservations` `status = 'active'`.
- **We deliberately do not revoke `public.reserve_token_usage` in any migration that runs in every
  environment.** Revoking it is the *actual point of no return* for the legacy system, and doing
  that inside a migration means it fires identically in every environment the migration ever
  touches, including ones where `quad_zero_check()` has never been run. That belongs in a manual
  runbook step, gated by a human reading `quad_zero_check()` output for the specific environment
  being cut over:

  > **Manual cutover runbook (do this by hand, per environment):**
  > 1. `select runtime.enter_billing_maintenance('<operator>', 'BILLING_V2_CUTOVER');`
  > 2. `select billing_legacy.quad_zero_check();` — confirm all four counts are `0`.
  > 3. `select billing.activate_global_cutover('<operator>', 'BILLING_V2_CUTOVER');` — this is the
  >    global, one-way admission flip (§5); it already snapshots every account and resumes
  >    maintenance atomically as part of the same transaction.
  > 4. Only after step 3 returns `status = 'activated'`, revoke the legacy admission entry point —
  >    this is the actual point of no return:
  >    ```sql
  >    revoke execute on function public.reserve_token_usage(uuid, text, bigint, bigint, uuid, uuid)
  >      from service_role;
  >    ```
  >    Do **not** revoke `finalize_token_usage`/`release_token_usage` — in-flight legacy reservations
  >    created before the revoke must still be settleable.

---

## 6. What Is Deliberately Out of Scope

- Automatic bucket **purchase** flows (Stripe/payment provider webhooks creating `usage_buckets`
  rows) are not part of this ADR; `reserve_usage` assumes buckets already exist.
- Rewiring the actual token-spending call sites (Edge Functions currently calling
  `reserve_token_usage`/`finalize_token_usage`) to call `billing.reserve_usage` instead. This ADR
  ships the new system and the drain machinery; the call-site migration is a follow-up once
  `billing` has run in shadow (ledger-only, no denial) for at least one full billing cycle per
  account, mirroring the ADR 002 shadow-before-live pattern.

---

## 7. Reconciliation and No-Dual-Charge

Exactly one admission route may record a given unit of work at any point in the environment's
timeline, governed entirely by `billing.cutover_state.v2_active` (§5): before activation only
`public.reserve_token_usage` admits and `billing.reserve_usage` denies; during the maintenance
window opened by `runtime.enter_billing_maintenance` (`claims_paused`/`ingestion_paused`), both
deny; after a successful `billing.activate_global_cutover`, only `billing.reserve_usage` admits and
`public.reserve_token_usage` denies. The companion test file's routing/cutover test exercises all
three phases against one logical work id and asserts: (a) pre-activation, legacy admits and v2
denies with `denied_cutover_inactive`; (b) during maintenance, both deny; (c) post-activation,
legacy denies with `denied_cutover_active` for a new key, **and a retry of the SAME key legacy
already admitted and finalized before activation is not re-admitted or re-charged by v2**; (d) a
genuinely distinct new key still admits normally under v2, with exactly one ledger row.

### 7.1 Cross-scheme idempotency at cutover

`p_idempotency_key` (v2) and `billing_key` (legacy) are the same caller-chosen key space — a
caller that retries the identical logical unit of work across the cutover boundary passes the same
string to whichever admission function it calls. Without an explicit check, a legacy reservation
finalized *before* activation could be retried with the same key *after* activation and be admitted
and charged fresh by `billing.reserve_usage`, double-charging the same logical work. To close this,
`billing.reserve_usage` — immediately after locking the account's policy row and before its own v2
idempotency lookup, budget check, or FEFO allocation — locks (`for update`) any
`public.token_usage_reservations` row for `(account_id, billing_key = p_idempotency_key)` and
branches on its status:

- `finalized` → returns `status = 'legacy_finalized', idempotent_replay = true` and creates **no**
  v2 reservation and **no** ledger entry. This is the double-charge case being closed.
- `active` → returns `status = 'denied_legacy_active'` (fail closed). An active legacy row after
  cutover means the cutover gate was raced or bypassed; admitting fresh v2 work under the same key
  in that state risks a second admission for work the legacy side still considers in flight.
- `released` / `expired` → falls through to the normal v2 admission path. Both statuses mean the
  legacy reservation consumed no lasting balance (it was refunded on release or swept unfinalized
  on expiry), so a fresh v2 reservation under the same key is exactly the correct outcome, not a
  double-charge.

The policy-row lock taken earlier in `reserve_usage` already serializes concurrent callers for the
same account, so this lookup is race-free against a concurrent legacy writer for the same reason
the existing v2 idempotency lookup is.

### 7.2 Real cutover reconciliation

`billing_legacy.reconciliation_report()` (service-role-only, `security definer set search_path =
''`, read-only) is the actual migration-reconciliation check — distinct from the ongoing
bucket/allocation conservation check below. It recomputes, directly from the rows
`activate_global_cutover` itself wrote, what should have happened and compares it to what actually
did:

- `expected_units` — `sum(floor(drain_snapshots.snapshotted_balance * pricing_matrices.
  conversion_rules ->> 'legacy_credit_to_unit'))`, joined by `drain_snapshots.
  pricing_matrix_version`.
- `bucket_units` — `sum(usage_buckets.total_units)` for the bucket each snapshot's
  `granted_bucket_id` points at.
- `ledger_grant_units` — `sum(usage_ledger.units)` for the `event_type = 'grant'` row tied to that
  same bucket.
- `bucket_delta` / `ledger_delta` — `bucket_units - expected_units` / `ledger_grant_units -
  expected_units`.
- `mismatched_accounts` — count of snapshots where the per-account expected amount disagrees with
  either its bucket or its ledger row.

`billing.activate_global_cutover` calls this report in the same transaction, after writing the
snapshots/buckets/grants and before clearing maintenance or flipping `v2_active`, and raises
(rolling back the entire cutover) unless every delta and the mismatch count are exactly zero. The
companion pgTAP invariant asserts the same on a real activation.

The ongoing conservation check (bucket `total_units = remaining_units + sum(allocated -
refunded)` across `usage_reservation_allocations`, and reservation `reserved_units = sum
(allocated_units)`) is a separate, always-true operational invariant under normal reserve/finalize/
release traffic — it is not a migration-reconciliation check and is documented as such where it is
asserted.

### 7.3 Kill switch independence

`kill_switch_active` is `runtime.system_controls`' incident kill switch — an unrelated control from
the billing-maintenance pause flags (`claims_paused`/`ingestion_paused`), even though all three
share the same row and the same `reason_code`/`activated_by`/`activated_at` metadata columns. That
column sharing is exactly what made it possible for a billing-maintenance action to silently step
on an incident already in progress:

- `runtime.enter_billing_maintenance` fails closed if `kill_switch_active` is already `true`,
  before writing anything — it never overwrites the incident's `reason_code`/`activated_by`/
  `activated_at` with billing-maintenance metadata.
- `runtime.resume_from_maintenance` never writes `kill_switch_active` at all, and fails closed if it
  is `true` — a billing-maintenance resume can never clear (or be used to clear) the kill switch.
- `billing.activate_global_cutover` locks and checks `runtime.system_controls` — rejecting an active
  kill switch — before it locks `billing.cutover_state` and reads `v2_active`, so a kill switch
  raised after v2 is already live still fails the call closed instead of hitting the
  already-active short-circuit and returning success. Its own maintenance-clearing `UPDATE` only
  ever touches `claims_paused`/`ingestion_paused` and the shared metadata columns — never
  `kill_switch_active`.

Clearing the kill switch is a separate, incident-scoped action outside all three of these RPCs. The
companion pgTAP invariant sets `kill_switch_active = true` directly, asserts all three RPCs fail
closed and leave both the flag and the incident's own metadata untouched, then clears it directly
and asserts a subsequent resume behaves normally.
