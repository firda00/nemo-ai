# ADR 004: High-Load Order Service — Tenant-Safe FSM, Kafka Outbox/Inbox, and Inventory Reservation

**Status:** Proposed
**Date:** 2026-08-26
**Deciders:** Core Engineering Team
**Consulted:** Security, Commerce/Fulfillment, Infrastructure
**Informed:** Product, Executive Team
**Supercedes / Depends on:** ADR 001 (Durable Operations Runtime), ADR 003 (Usage Metering,
Reservation Safety); shares the closed-schema/composite-FK/fenced-lease conventions of both but
introduces a new `commerce_runtime` schema rather than extending `runtime` or `billing`.

---

## 1. Core Architectural Invariant

> **The Exactly-Once-Effect Invariant:**
> No order may be created twice from the same logical request, no inventory unit may be reserved
> twice or lost to a lost update, and no order transition may apply against a state the caller did
> not actually observe. Every mutation is fenced by `state_version` (orders) or
> `lease_epoch`/`claim_token`/`lease_holder` (outbox), every multi-row inventory update is
> all-or-nothing, and every consumer-side dedupe check runs in the same transaction as the business
> mutation it guards. **Kafka publication itself is at-least-once, not exactly-once** — see the
> correction below — and it is the consumer side (§5.5), not the outbox, that turns repeated
> publication into exactly-once business effect.
>
> **Correction: the outbox cannot make Kafka publication exactly-once.** A worker that successfully
> publishes to Kafka and then crashes (or loses connectivity) before calling
> `finish_order_outbox_event` leaves the event `processing` under a lease that will simply expire;
> `claim_order_outbox_events` then reclaims it under a new `lease_epoch` and it is published again.
> This is by design, not a bug — the alternative (marking published before the publish is confirmed)
> can silently drop events instead — but it means every domain event must be treated by its Kafka
> consumers as **at-least-once delivery**: `order_outbox_events.id` (or `dedupe_key`) is a stable
> event identifier that belongs in the Kafka message so consumers can deduplicate, the Kafka producer
> should be configured idempotent (`enable.idempotence=true`) to collapse producer-side retries, and
> any consumer that itself causes a side effect must be idempotent or run its own inbox-style dedupe
> (exactly what `commerce_runtime.consume_order_event`, §5.5, does for this service's own inbound
> consumption). The only place in this ADR that can honestly claim exactly-once *effect* is that
> inbox/transition pairing — never the outbox's claim/publish/finish cycle in isolation.

This is a **correctness and safety** invariant, not a throughput guarantee. See §2.

---

## 2. Why 10k RPS Is a Workload Target, Not a Guarantee This DDL Provides

The brief for this service names 10k RPS as a design target. Schema and RPC design (row-level
locking scoped to exactly the rows a transaction needs, deterministic lock ordering to avoid
deadlock-driven retries, `SKIP LOCKED` on independent queue scans, narrow hot-row critical sections)
remove the *structural* reasons a naive design would fall over under load. None of that is a
substitute for measuring the deployed system: connection pooling limits, autovacuum behavior on the
hottest tables (`orders`, `inventory`, `order_outbox_events`), Kafka consumer/producer throughput,
and the actual contention profile of production traffic (how concentrated reservations are on a
small number of hot SKUs, how many accounts are active concurrently) all determine whether 10k RPS
is achievable on given hardware. **This ADR does not claim 10k RPS is met by shipping this schema.**
Before that number is used in any capacity planning or SLA, it must be validated with a load test
against a realistic data shape and hardware profile, and the result — including the contention
pattern that limits it — should be recorded as a follow-up to this ADR. Concretely:

- The FEFO-style deterministic lock order used by `reserve_inventory` (sorted by `product_id`)
  bounds deadlock risk but does not bound *lock wait time* under a hot single-SKU flash-sale
  pattern; that is a capacity question, not a correctness one.
- `order_outbox_events` claim throughput is bounded by how fast workers publish to Kafka and call
  `finish_order_outbox_event`, not by the claim RPC itself (`SKIP LOCKED` claims never wait on
  in-flight publishes).
- No connection pooling, read-replica routing, or partitioning strategy is specified here. If
  `orders`/`order_outbox_events` volume outgrows single-table performance, that is a follow-up ADR,
  not a retrofit into these RPCs' contracts.

---

## 3. Why Not Reuse Existing Tables

### 3.1 `runtime.outbox_actions` is the wrong shape for Kafka domain events

`runtime.outbox_actions` (ADR 001) is a **policy-controlled external side-effect queue**: every row
carries `workflow_id`/`transition_id`/`policy_decision_id`/`approval_request_id` foreign keys into
the durable-operations runtime, an `execution_mode` (`shadow`/`live`) governed by the ADR 002
shadow-before-live gate, and a `connector_id` naming the specific external system integration that
executes the action. None of that applies to a Kafka **domain event** — "an order was created", "an
order transitioned to `shipped`" — which has no policy decision behind it, no approval workflow, no
per-connector execution mode, and instead needs `event_type`/`event_version`/`schema_version` fields
for consumer-side schema evolution and a stable Kafka partition key. Bolting domain-event semantics
onto `outbox_actions` would mean either leaving five NOT NULL policy/workflow columns meaninglessly
populated for every order event, or loosening those columns to nullable and losing the invariant
that every *policy-governed* action really is policy-governed. `order_outbox_events` is a new,
narrower table for exactly the domain-event shape, published by a Kafka producer worker rather than
executed by a connector.

### 3.2 `commerce_inventory_snapshots` is append-only observational data, not live stock

`public.commerce_inventory_snapshots` (see the Uzum Commerce Control Center, `20260805090000
_commerce_control_center.sql`) is a periodic **observation** of marketplace-reported stock —
`unique(sku_id, observed_slot)`, one row per sync tick, no row is ever updated, and it exists to
detect drift and freshness, not to be locked and decremented by concurrent reservation transactions.
Using it as operational stock would mean either violating its append-only contract (turning a
historical fact table into a mutable ledger, breaking every consumer that assumes a snapshot never
changes after insert) or taking `for update` locks against a table whose insert rate is driven by an
unrelated sync cadence. `commerce_runtime.inventory` is a new table: one row per `(account_id,
product_id)`, `available`/`reserved` counters mutated in place under row locks, with its own
`version` column for optimistic-conflict visibility to callers that read it outside a reservation.

---

## 4. Schema (`commerce_runtime`)

Closed schema, identical pattern to `billing`/`runtime`: `revoke all on schema commerce_runtime from
public, anon, authenticated; grant usage on schema commerce_runtime to service_role;`, every table
additionally `revoke all ... from public, anon, authenticated`, and all access goes through
`security definer` RPCs with `set search_path = ''`. No RLS policies exist in this schema — as in
`billing`, the tables are unreachable by any role other than the RPC's definer, so an Edge Function
bug cannot bypass fencing/idempotency by issuing raw DML.

### 4.1 `commerce_runtime.allowed_order_transitions`

Composite-PK lookup table (`from_state`, `to_state`), the same pattern as `runtime
.allowed_workflow_transitions`. No `ENUM` type is used anywhere in this schema; every state column
is `text` with a `CHECK` constraint, and **transition legality is enforced by a composite foreign
key** from `order_transitions(from_state, to_state)` into this table — an invalid transition is
rejected by Postgres itself (`23503` foreign_key_violation) before any application code has to check
it, and adding a new legal transition is a data change (one `INSERT` here), not a type migration.
`'new'` is a sentinel pseudo-state that only ever appears as a `from_state` — the single row
`('new', 'created')` is the birth transition every order gets exactly once, so `order_transitions`
is complete from an order's very first row without a nullable `from_state` column. `'new'` is never
a legal `orders.status` value and never appears as a `to_state`.

The lifecycle is: `created -> inventory_reserved -> payment_pending -> paid -> confirmed ->
fulfilling -> shipped -> completed`, with explicit branches at each fallible step rather than a
single generic `failed`/`cancelled` catch-all:

- `created -> inventory_rejected` — `reserve_inventory` could not admit every requested line
  (missing product row or insufficient stock); see §5.3.
- `inventory_reserved -> payment_pending -> paid | payment_failed` — payment is its own explicit
  two-step branch, not folded into a generic `failed`.
- `created | inventory_reserved | payment_pending | paid -> cancelled` — cancellation is legal from
  every pre-fulfillment state (see §6 for what is *not* shipped here: automatic inventory release on
  cancellation of an already-reserved order).
- `confirmed | fulfilling | shipped -> failed` — `failed` is kept only for the fulfillment stages
  (a carrier failure, a fulfillment-center exception) that this ADR does not attempt to subdivide
  further; it is not used for inventory or payment failure, which have their own named states above.

### 4.2 `commerce_runtime.orders`

One row per order. `unique(account_id, idempotency_key)` gives tenant-scoped idempotency for
`create_order`. `payload_hash` (`sha256`, hex, via `pgcrypto.digest`) is computed over the
caller-supplied immutable inputs (`currency`, `total_amount_minor`, `customer_ref`,
`order_payload`) and is the collision defense described in §5.1: a retried `create_order` call with
the same idempotency key and an *identical* payload hash replays the original result; a call with
the same key and a *different* hash is a genuine idempotency-key collision (two different logical
orders trying to share one key) and is rejected, never silently overwritten or silently returned as
if it were the first order. `state_version` is **1-based**: an order's birth transition
(`order_transitions.transition_seq = 1`, `'new' -> 'created'`) is applied in the same transaction as
the `orders` insert, so an order is never observed at `state_version = 0` — it starts at `1` and
increments by exactly one per subsequent committed transition. `state_version` is both the
optimistic-concurrency fence for `transition_order`/`reserve_inventory` and, by construction, equal
to the latest `order_transitions.transition_seq` for that order (an earlier draft of this schema
started `state_version` at `0` while still assigning the birth transition `transition_seq = 1`,
which meant the *first real* transition after creation computed `new_version = 0 + 1 = 1` and
collided with the birth row's own `transition_seq = 1` under
`order_transitions_seq_unique(account_id, order_id, transition_seq)` — every first transition on
every order would have failed with a unique-violation; starting at `1` is what makes `state_version`
actually equal `transition_seq` from the order's first row onward). `total_amount_minor` is an
integer minor-unit amount (matches the `_tiyin`-suffixed columns already used in
`public.commerce_skus`); `currency` is validated `~ '^[A-Z]{3}$'` (ISO 4217 alphabetic code shape —
not validated against a currency table, which is a deliberate simplification noted in §8).

### 4.3 `commerce_runtime.order_transitions`

Append-only audit/event-sourcing log, one row per state change including the birth transition.
`unique(account_id, order_id, transition_seq)` plus the composite `(account_id, order_id)` foreign
key into `orders` (matching the tenant-composite-FK pattern used throughout `runtime`/`billing`) means
the sequence is gap-free and race-free per order — `transition_seq` is always `orders.state_version`
*after* the transition that produced the row, so a concurrent second writer racing the same expected
version can never produce two rows with the same `transition_seq` (the `orders` row lock taken by
`transition_order`/`reserve_inventory` serializes that). A `BEFORE UPDATE OR DELETE` trigger
(`commerce_runtime.prevent_order_transition_mutation`, `errcode '0OS01'`) makes the table immutable
even against a direct table writer, not just by convention — the same treatment
`billing.usage_ledger` and `runtime.audit_events` get.

### 4.4 `commerce_runtime.order_outbox_events`

Kafka domain-event outbox — see §3.1 for why this is not `runtime.outbox_actions`. Explicit status
lifecycle `pending -> processing -> (published | retry_scheduled -> processing again |
dead_letter)`, fenced by `claim_token`/`lease_holder`/`lease_until`/`lease_epoch` exactly like
`runtime.outbox_actions`'s claim/lease pattern (§5.4). `dedupe_key` (`unique(account_id,
dedupe_key)`) is a defense-in-depth idempotency key distinct from any Kafka-side deduplication: for
the birth event it is `<order_id>:order.created`, for a transition event it is
`<order_id>:<to_state>:<state_version>` — both are naturally unique per logical event because
`state_version` only advances once per transition under the `orders` row lock, so this is a second,
independent guard against a bug that calls the insert twice, not the primary correctness mechanism
(which is that the insert happens in the same transaction as the state change it reports, so it can
never be missing, and the claim/lease/publish-once contract in §5.4 is what prevents Kafka from
seeing two published copies of a row that outlived its lease). **The Kafka partition key is
`order_id`** — no separate partition-key column exists; the publisher worker partitions by the
existing `order_id` column so that all events for one order are strictly ordered on the consumer
side. `event_version`/`schema_version` let consumers evolve independently of producers, per the
project's `runtime` conventions (`canonicalization_version`/`policy_version` on `outbox_actions`).

### 4.5 `commerce_runtime.consumer_inbox`

Tenant-scoped dedupe table for inbound Kafka messages this service consumes (e.g., a payment or
fulfillment confirmation from another service that should drive an order transition).
`unique(account_id, source_topic, external_message_id_hash)` — the hash (not the raw id) is what is
uniquely constrained, matching the `idempotency_key_hash` pattern on `runtime.outbox_actions`, so an
arbitrarily long upstream message id never has to fit a btree-friendly column directly. See §5.5 for
why dedupe and the resulting business mutation must be one RPC, not two.

### 4.6 `commerce_runtime.inventory`

Operational stock ledger, `primary key (account_id, product_id)` — see §3.2 for why this is not
`commerce_inventory_snapshots`. `available`/`reserved` are both `>= 0` `CHECK`-constrained; there is
no `total` column because `available + reserved` at any instant already reconstructs it and storing
a third redundant number invites drift. `version` is a plain counter incremented on every mutating
statement, exposed to any future caller that wants to detect "did this change since I last read it"
outside a reservation's own locking — it is not itself the concurrency mechanism for reservations
(that is the row lock `reserve_inventory` takes; see §5.3).

### 4.7 JSON and numeric bounds

`order_payload`/outbox `payload` are capped at 65536 bytes (64 KiB, the bound named explicitly in
the task brief); `transition_payload` on `order_transitions` is capped at 16384 bytes (16 KiB) —
transitions carry structured metadata about *why* a transition happened, not arbitrary order
contents, which already live once on the `orders` row. Every `jsonb` column has a matching
`jsonb_typeof(col) = 'object'` check, matching the `billing`/`runtime` convention exactly. Bounded
text fields (`idempotency_key`, `customer_ref`, `correlation_id`, `actor_id`, `dedupe_key`,
`external_message_id`, `source_topic`) all carry explicit `char_length(...) between`/`<=` checks —
none is unbounded `text` with no shape constraint.

---

## 5. RPCs

All RPCs are `security definer`, `set search_path = ''`, validate every input with `raise exception
using errcode = '22023'` before touching any row, and finish with `revoke all ... from public, anon,
authenticated; grant execute ... to service_role;` plus a `comment on function`. No payload or error
field ever includes raw PII — `order_payload`/`transition_payload` are opaque caller-supplied jsonb
the service does not interpret, and every `sanitized_error_message` field is named to signal that
whatever writes it must have already stripped anything sensitive before it reaches this table (the
same convention `runtime.outbox_actions.sanitized_error_message` uses).

### 5.1 `commerce_runtime.create_order`

1. Validates inputs: idempotency key shape, ISO-shaped currency, `total_amount_minor >= 0`,
   `customer_ref` length, `order_payload` object/size bound.
2. Computes `payload_hash` over the canonical immutable inputs.
3. Attempts `INSERT ... ON CONFLICT (account_id, idempotency_key) DO NOTHING RETURNING *` directly —
   it does **not** first `SELECT ... FOR UPDATE` the idempotency key to check whether a row already
   exists. A `SELECT ... FOR UPDATE` against a key with no existing row takes no gap lock in
   Postgres, so two concurrent calls with the same brand-new key would both observe "not found" and
   both attempt the `INSERT`, and one would lose to `unique_violation` instead of getting a clean
   replay/collision answer. The `INSERT ... ON CONFLICT` form makes Postgres itself the arbiter: a
   losing inserter blocks on the `(account_id, idempotency_key)` unique index until the winner's
   transaction commits (or rolls back), so by the time the losing inserter's `ON CONFLICT DO NOTHING`
   resolves to "did nothing," the winner's row — if it committed — is guaranteed visible to the very
   next `SELECT` in the same function.
4. If the `INSERT` won (a row came back from `RETURNING`), this call is the sole creator: it inserts
   the birth `order_transitions` row (`from_state = 'new'`, `to_state = 'created'`,
   `transition_seq = 1`) and one `order_outbox_events` row (`event_type = 'order.created'`) in the
   same transaction as the order insert — a crash between any two of these three writes rolls all of
   them back; there is no window where an order exists without its birth transition or its creation
   event. The order is created at `state_version = 1` (see §4.2 for why not `0`).
5. If the `INSERT` did not win, this call reads the now-committed existing row (a plain `SELECT`,
   no lock needed — see step 3) and compares `payload_hash`: matching hash → returns the existing
   order's identity/state unconditionally (safe retry, including retries that raced past a partial
   failure on the client side, and including a concurrent call that raced the winner and merely lost
   the insert); mismatched hash → returns `status = 'idempotency_key_collision'` and creates nothing
   — this is the "reject collision" behavior named in the task brief, not a silent overwrite. Only
   the insert's winner ever creates the birth transition/outbox row, so N concurrent identical
   `create_order` calls under the same key produce exactly one order, one birth transition, and one
   outbox event, never more.

### 5.2 `commerce_runtime.transition_order`

Generic FSM transition for every state change that does not itself touch inventory (`confirmed`,
`fulfilling`, `shipped`, `completed`, `cancelled`, `failed`).

1. Locks the order `for update`. Not found → `P0002`.
2. `state_version <> p_expected_state_version` → raises `55000` ("stale order state version") —
   the caller observed a version that is no longer current and must re-read before retrying; this is
   optimistic concurrency, not idempotency-key replay, because a transition is an action taken
   against a specific observed state, not a request with its own identity.
3. Inserts the `order_transitions` row with `from_state = <current status>`, `to_state =
   p_to_state`. An illegal pair is rejected by the `allowed_order_transitions` composite FK
   (`23503`) before any other row is touched.
4. Updates `orders.status`/`state_version` (`state_version = state_version + 1`, guarded again by
   `where state_version = p_expected_state_version` as defense in depth against a future code path
   that forgets the earlier lock).
5. Inserts one `order_outbox_events` row (`event_type = 'order.transitioned'`,
   `dedupe_key = '<order_id>:<to_state>:<new_state_version>'`).

### 5.3 `commerce_runtime.reserve_inventory`

The one RPC that mutates both `inventory` and `orders` atomically — the `created -> reserved`
transition specifically requires an all-or-nothing multi-SKU stock check, so it cannot be expressed
as a generic transition plus a separate inventory call without reopening a window where the order
moves to `reserved` before stock is actually committed (or vice versa).

1. Validates `p_items` is a non-empty JSON array of `{product_id, quantity}` objects, `quantity`
   a positive integer, and the array is bounded (≤500 distinct line items) — bounds every input
   before any lock is taken.
2. **Aggregates duplicate `product_id`s** by summing requested quantity — a caller (or a buggy
   upstream cart) that lists the same SKU twice must not be able to bypass the stock check by
   splitting one oversized request into two smaller ones that each individually look satisfiable.
3. Locks the order `for update` and checks `state_version`/`status = 'created'` exactly as
   `transition_order` does (fenced, stale-write-rejected).
4. Locks every **existing** requested inventory row **`for update`, ordered by `product_id`
   ascending** — deterministic across every caller of this RPC and every other RPC that will ever
   lock `inventory` rows, so two concurrent reservations that happen to share SKUs can never form a
   lock-ordering deadlock cycle (the same reasoning ADR 003 §4.1 documents for `usage_buckets`).
   There is deliberately **no unlocked pre-check** for missing rows before this lock loop: an
   earlier draft checked `not exists (select 1 from inventory where product_id = id)` first and only
   then took the lock, which leaves a window where a product row that existed at pre-check time is
   concurrently deleted before the lock is acquired — the lock loop would simply not find that row
   (nothing to lock), and if the pre-check result were trusted rather than re-derived from what
   actually got locked, the function could report the line as present when it no longer is. Instead,
   `v_missing` (requested ids with **no** locked row) is computed *after* the lock loop, by comparing
   the full requested id list against the set of ids the loop actually locked — a row can only be
   "missing" if it is unlocked at the moment this function checks, not at some earlier unlocked read.
5. **Verifies stock for every locked row before mutating any of them.** If any requested product
   has no locked row (`v_missing`) or `available < requested` (`v_short`), the function does not
   merely return a denial and leave the order sitting in `created` — it atomically calls
   `commerce_runtime.transition_order` for `created -> inventory_rejected` (reason code
   `INVENTORY_MISSING_ROW` or `INSUFFICIENT_STOCK`, transition payload listing every
   short/missing product) **in the same transaction**, so the order lands on a definite terminal
   branch and emits that transition's outbox event, rather than being left in an ambiguous
   "not yet reserved" state a caller or downstream consumer has to interpret. No inventory row is
   updated either way — the row locks are released unchanged when the transaction ends, exactly as
   ADR 003 §4.1 describes for FEFO bucket admission. This is the all-or-nothing guarantee: partial
   reservation of some SKUs while others fail is not a state this function can produce.
6. On success, applies every row's `available -= qty, reserved += qty, version = version + 1` in
   one set-based `UPDATE ... FROM (SELECT unnest(...))` statement (matches the `billing.reserve_usage`
   bucket-decrement pattern), then calls `commerce_runtime.transition_order` for the `created ->
   inventory_reserved` transition **within the same transaction** — a Postgres function call does not
   open a new transaction, so the inventory mutation and the FSM transition (and its outbox event)
   commit or roll back together with no intermediate observable state.

### 5.4 `commerce_runtime.claim_order_outbox_events` / `finish_order_outbox_event`

Mirrors `public.runtime_claim_outbox_actions`/`runtime_finish_outbox_action` (ADR 001), with one
addition this table's status lifecycle needs and `outbox_actions` does not: self-healing an
exhausted, expired lease (see below).

- **Claim**: a single atomic statement — one `WITH` containing a `SELECT ... FOR UPDATE SKIP
  LOCKED` candidate scan feeding an `UPDATE ... FROM candidates`, not a PL/pgSQL loop that updates
  one candidate row at a time. Candidates are `status = 'pending'`, or `'retry_scheduled'` past
  `next_attempt_at`, or `'processing'` past an **expired** `lease_until` with attempts remaining —
  the last clause is what makes an abandoned-but-still-retryable lease reclaimable without a
  separate sweep job. Each claimed row gets a fresh `claim_token`, `lease_epoch = lease_epoch + 1`,
  and `lease_until = now() + lease_duration`. Before that candidate scan runs, the same statement
  also **dead-letters, in a sibling CTE, any `processing` row whose lease has expired *and* whose
  `attempt_count` has already reached `max_attempts`** — such a row can never satisfy the candidate
  predicate (`attempt_count < max_attempts` correctly excludes it from being reclaimed for another
  attempt it isn't entitled to), and without this explicit dead-lettering step it would simply stay
  `processing` with a dead lease forever, invisible to both claim and any future caller, because
  nothing else in this schema ever revisits a `processing` row on its own. The function never holds
  any lock while talking to Kafka — it returns the claimed batch to the caller, which publishes
  *outside* this transaction, and reports back via `finish_order_outbox_event` in a second, separate
  transaction. This is the same "never hold a DB lock across a network call" discipline the
  `runtime` claim/finish pair already established.
- **Finish**: requires `status = 'processing'`, matching `claim_token`, `lease_epoch`, **and**
  `lease_holder = p_worker_id`, plus an unexpired `lease_until` — a worker whose lease already
  expired (and was reclaimed by another worker) is rejected with `55000` even if it eventually gets
  around to calling finish, and a worker id that does not match the current `lease_holder` is
  rejected too (a token/epoch match alone does not prove *this* worker is the one holding the
  lease), so two workers can never both believe they successfully published the same event.
  `p_result_status` accepts `published`, `retry_scheduled`, or `dead_letter` — **not** `failed`,
  which is not one of `order_outbox_events`'s own `CHECK`-constrained statuses
  (`pending`/`processing`/`retry_scheduled`/`published`/`dead_letter`); a caller-observed publish
  failure must already be classified as `retry_scheduled` (attempts remain) or `dead_letter`
  (attempts exhausted) before calling finish, and both of those now **require a sanitized error
  code** — a failure worth scheduling a retry or giving up on is a failure worth recording *why*,
  not just *that*. `retry_scheduled` requires (or computes, when the caller does not supply one) a
  `p_next_attempt_at` that the function itself bounds to `[now(), now() + 24h]` regardless of what
  the caller passes (default: `now() + least(3600s, 2^attempt_count seconds)`, i.e. capped
  exponential backoff). If the event has already exhausted `max_attempts`, a `retry_scheduled`
  result is silently upgraded to `dead_letter` by the function itself — the caller cannot
  accidentally schedule an infinite retry loop past the configured attempt budget; this is the
  in-transaction complement to claim's own dead-lettering of rows that reach that exhaustion while
  already abandoned (lease expired) rather than while being actively finished.

### 5.5 `commerce_runtime.consume_order_event`

The atomic consumer-side inbox/mutation pattern: `INSERT ... ON CONFLICT (account_id, source_topic,
external_message_id_hash) DO NOTHING RETURNING id` against `consumer_inbox`, in the **same**
function (hence the same transaction) as the `transition_order` call it guards. If the insert is
skipped (conflict — this message id was already processed for this topic), the function returns
`status = 'duplicate_ignored'` and calls `transition_order` **not at all**. If the insert succeeds,
it calls `transition_order` in the same transaction; if that call raises (invalid transition, stale
version), the **entire transaction rolls back, including the inbox insert** — a message whose
resulting mutation failed is not marked consumed, so a legitimate redelivery (after whatever caused
the failure is fixed) can still be processed. This function does not and cannot claim exactly-once
*delivery* — Kafka's delivery guarantee is a broker/consumer-group property this schema has no
control over — it claims exactly-once *effect application* for whatever number of times the same
message is actually delivered to this function.

---

### 5.6 `public.commerce_*` — RPC-exposure wrappers

Supabase/PostgREST exposes only the schemas listed in the project's `db.schemas` config, which
defaults to `public` (and `graphql_public`) and does **not** include `commerce_runtime`. A function
that exists only in `commerce_runtime` — however correctly it validates input, fences its writes,
and locks in the right order — is simply unreachable through `supabase.rpc(...)` or any other
PostgREST-based client; it can only be called from a raw Postgres connection with the right role,
which an Edge Function does not use for this purpose. Each RPC in §5.1–§5.5 therefore gets a thin
`public.commerce_*` wrapper (`commerce_create_order`, `commerce_transition_order`,
`commerce_reserve_inventory`, `commerce_claim_order_outbox_events`,
`commerce_finish_order_outbox_event`, `commerce_consume_order_event`) — same argument shapes, no
added logic beyond the pass-through call — that is itself `security definer` with
`set search_path = ''`, revoked from `public`/`anon`/`authenticated`, and granted only to
`service_role`, exactly like the `commerce_runtime` function it wraps. Exposing a callable contract
through `public` does not loosen the closed-schema access model: `commerce_runtime` itself stays
fully unreachable by any role except through these definer functions, and the wrappers are reachable
by service_role only, same as before.

## 6. What Is Deliberately Out of Scope

- **Compensating inventory release on `reserved -> cancelled`.** This ADR ships
  `reserve_inventory` (stock debit) but not its mirror-image release RPC. A production cancellation
  flow for an already-reserved order needs a `release_inventory` RPC with the same deterministic
  lock order before it is safe to call from a live cancellation path; until then, `transition_order`
  can still move `reserved -> cancelled` at the FSM level, but the corresponding stock is not
  automatically credited back. Flagged explicitly rather than silently omitted, per the ADR 003
  precedent of naming what a schema does not yet cover.
- **Currency-table validation.** `currency ~ '^[A-Z]{3}$'` checks shape, not that the code is a real
  ISO 4217 currency your payment provider actually supports — that belongs to whatever validates
  the order at the API boundary before `create_order` is called.
- **Automatic inventory provisioning.** `commerce_runtime.inventory` rows are assumed to already
  exist (created by a separate stock-management flow, out of scope here) before `reserve_inventory`
  is ever called; a product with no `inventory` row is reported as `denied_missing_inventory_row`,
  not auto-created with zero stock.
- **The actual Kafka producer/consumer worker processes.** This ADR defines the outbox/inbox tables
  and the claim/finish/consume RPC contracts a worker must honor; it does not ship the worker code
  that calls them, mirroring how ADR 001 shipped `runtime.outbox_actions` and its RPCs without the
  connector worker implementations.
- **10k RPS as a met target** — see §2.

---

## 7. Concurrency Summary (cross-reference for the invariant test suite)

| Scenario | Mechanism | Section |
|---|---|---|
| N concurrent identical `create_order` calls, same key+payload | `INSERT ... ON CONFLICT DO NOTHING` — one winner creates order+birth transition+outbox, every other call reads the committed row and replays; zero `unique_violation`s | §5.1 |
| Duplicate `create_order` retry, different payload | Payload hash mismatch → `idempotency_key_collision`, rejected | §5.1 |
| Two transitions racing the same order | `state_version` fencing, one wins, one gets `55000` | §5.2 |
| Illegal transition pair | `allowed_order_transitions` composite FK → `23503` | §4.1, §5.2 |
| Multi-SKU reservation, one SKU short or missing | All existing rows locked first, then checked; no update issued; order atomically transitions to `inventory_rejected` instead of staying in `created` | §5.3 |
| Product row deleted between an unlocked pre-check and the lock | Eliminated — there is no unlocked pre-check; missing-ness is derived from what the lock loop actually locked | §5.3 |
| Multi-SKU reservation, duplicate SKU in request | Aggregated before locking/checking | §5.3 |
| Two reservations sharing SKUs | Deterministic `product_id asc` lock order — no deadlock | §5.3 |
| Outbox worker publishes then crashes before `finish` | Lease expires, `claim` reclaims it under a new `lease_epoch`, event is republished — **at-least-once**, not exactly-once; see the correction in §1 and the dedupe/idempotent-consumer requirement it implies | §5.4 |
| A reclaimed lease's original worker eventually calls `finish` anyway | Rejected: stale `lease_epoch`/`claim_token`, or a `lease_holder` that no longer matches `p_worker_id` | §5.4 |
| Outbox event's lease expires on its *last* attempt (`attempt_count = max_attempts`) | `claim` dead-letters it in the same statement it runs its candidate scan — no separate sweep job, no permanently-stuck `processing` row | §5.4 |
| Same Kafka message delivered twice | `consumer_inbox` dedupe in the same transaction as the mutation it guards — this, not the outbox, is what turns at-least-once delivery into exactly-once effect | §5.5 |
| Mutation fails after dedupe insert | Whole transaction rolls back — message is not marked consumed | §5.5 |
