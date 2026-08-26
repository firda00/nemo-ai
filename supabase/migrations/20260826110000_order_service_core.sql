-- ADR 004: order service core schema — tenant-safe FSM, Kafka domain-event outbox, consumer
-- inbox, and operational inventory. Closed schema: every table is unreachable except through the
-- security-definer RPCs in the companion migration.

create schema commerce_runtime;
revoke all on schema commerce_runtime from public, anon, authenticated;
grant usage on schema commerce_runtime to service_role;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.allowed_order_transitions — FSM legality lookup, not an ENUM (ADR 004 §4.1).
-- 'new' is a sentinel from_state only: the birth transition ('new' -> 'created') is every order's
-- first row, and 'new' is never a legal orders.status value or a legal to_state.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.allowed_order_transitions (
  from_state text not null,
  to_state text not null,
  primary key (from_state, to_state),
  constraint allowed_order_transition_from_state_check check (from_state in (
    'new', 'created', 'reserved', 'confirmed', 'fulfilling', 'shipped'
  )),
  constraint allowed_order_transition_to_state_check check (to_state in (
    'created', 'reserved', 'confirmed', 'fulfilling', 'shipped', 'completed', 'cancelled', 'failed'
  )),
  constraint allowed_order_transition_not_identity_check check (from_state <> to_state)
);

insert into commerce_runtime.allowed_order_transitions (from_state, to_state) values
  ('new', 'created'),
  ('created', 'reserved'),
  ('created', 'cancelled'),
  ('created', 'failed'),
  ('reserved', 'confirmed'),
  ('reserved', 'cancelled'),
  ('reserved', 'failed'),
  ('confirmed', 'fulfilling'),
  ('confirmed', 'cancelled'),
  ('confirmed', 'failed'),
  ('fulfilling', 'shipped'),
  ('fulfilling', 'failed'),
  ('shipped', 'completed'),
  ('shipped', 'failed');

revoke all on commerce_runtime.allowed_order_transitions from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.orders
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.orders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  idempotency_key text not null,
  payload_hash text not null,
  status text not null default 'created',
  state_version bigint not null default 0,
  currency text not null,
  total_amount_minor bigint not null,
  customer_ref text,
  order_payload jsonb not null default '{}'::jsonb,
  correlation_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint orders_account_id_id_key unique (account_id, id),
  constraint orders_idempotency_key unique (account_id, idempotency_key),
  constraint orders_idempotency_key_shape_check check (
    char_length(idempotency_key) between 1 and 200
  ),
  constraint orders_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint orders_status_check check (
    status in (
      'created', 'reserved', 'confirmed', 'fulfilling', 'shipped',
      'completed', 'cancelled', 'failed'
    )
  ),
  constraint orders_state_version_check check (state_version >= 0),
  constraint orders_currency_check check (currency ~ '^[A-Z]{3}$'),
  constraint orders_total_amount_check check (total_amount_minor >= 0),
  constraint orders_customer_ref_check check (
    customer_ref is null or char_length(customer_ref) between 1 and 200
  ),
  constraint orders_payload_object_check check (jsonb_typeof(order_payload) = 'object'),
  constraint orders_payload_size_check check (octet_length(order_payload::text) <= 65536),
  constraint orders_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  )
);

create index orders_account_status_idx on commerce_runtime.orders (account_id, status, created_at);

revoke all on commerce_runtime.orders from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.order_transitions — append-only, immutable trigger, initial 'created' row.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.order_transitions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  order_id uuid not null,
  transition_seq bigint not null,
  from_state text not null,
  to_state text not null,
  actor_type text not null,
  actor_id text not null,
  correlation_id text,
  reason_code text,
  transition_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint order_transitions_account_id_id_key unique (account_id, id),
  constraint order_transitions_order_fkey foreign key (account_id, order_id)
    references commerce_runtime.orders (account_id, id) on delete restrict,
  constraint order_transitions_pair_fkey foreign key (from_state, to_state)
    references commerce_runtime.allowed_order_transitions (from_state, to_state) on delete restrict,
  constraint order_transitions_seq_check check (transition_seq > 0),
  constraint order_transitions_seq_unique unique (account_id, order_id, transition_seq),
  constraint order_transitions_actor_type_check check (
    actor_type in ('system', 'worker', 'user', 'admin', 'maintenance')
  ),
  constraint order_transitions_actor_id_check check (char_length(actor_id) between 1 and 160),
  constraint order_transitions_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  ),
  constraint order_transitions_reason_check check (
    reason_code is null or reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
  ),
  constraint order_transitions_payload_object_check check (
    jsonb_typeof(transition_payload) = 'object'
  ),
  constraint order_transitions_payload_size_check check (
    octet_length(transition_payload::text) <= 16384
  )
);

create index order_transitions_order_idx
  on commerce_runtime.order_transitions (account_id, order_id, transition_seq);

revoke all on commerce_runtime.order_transitions from public, anon, authenticated;

create function commerce_runtime.prevent_order_transition_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '0OS01', message = 'order_transitions is append-only';
end
$$;

create trigger order_transitions_immutable
  before update or delete on commerce_runtime.order_transitions
  for each row execute function commerce_runtime.prevent_order_transition_mutation();

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.order_outbox_events — Kafka domain-event outbox (ADR 004 §3.1, §4.4). Distinct
-- from runtime.outbox_actions, which is a policy-controlled external side-effect queue tied to the
-- durable-operations runtime's workflow/policy/approval lineage; this table has no such lineage and
-- instead carries event/schema versions for Kafka consumer evolution. Kafka partition key is the
-- existing order_id column — no separate partition-key column is needed.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.order_outbox_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  order_id uuid not null,
  event_type text not null,
  event_version text not null default 'v1',
  schema_version text not null default 'order-outbox-v1',
  payload jsonb not null default '{}'::jsonb,
  payload_hash text not null,
  dedupe_key text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  max_attempts integer not null default 8,
  next_attempt_at timestamptz,
  claim_token uuid,
  lease_holder text,
  lease_until timestamptz,
  lease_epoch bigint not null default 0,
  published_at timestamptz,
  last_error_code text,
  sanitized_error_message text,
  correlation_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint order_outbox_events_account_id_id_key unique (account_id, id),
  constraint order_outbox_events_order_fkey foreign key (account_id, order_id)
    references commerce_runtime.orders (account_id, id) on delete restrict,
  constraint order_outbox_events_dedupe_key unique (account_id, dedupe_key),
  constraint order_outbox_events_type_check check (char_length(event_type) between 1 and 160),
  constraint order_outbox_events_event_version_check check (
    char_length(event_version) between 1 and 40
  ),
  constraint order_outbox_events_schema_version_check check (
    char_length(schema_version) between 1 and 60
  ),
  constraint order_outbox_events_status_check check (
    status in ('pending', 'processing', 'retry_scheduled', 'published', 'dead_letter')
  ),
  constraint order_outbox_events_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint order_outbox_events_payload_size_check check (octet_length(payload::text) <= 65536),
  constraint order_outbox_events_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint order_outbox_events_dedupe_key_shape_check check (
    char_length(dedupe_key) between 1 and 300
  ),
  constraint order_outbox_events_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 50 and attempt_count <= max_attempts
  ),
  constraint order_outbox_events_retry_time_check check (
    (status = 'retry_scheduled' and next_attempt_at is not null)
    or (status <> 'retry_scheduled' and next_attempt_at is null)
  ),
  constraint order_outbox_events_lease_integrity_check check (
    (status = 'processing' and claim_token is not null and lease_holder is not null
      and lease_until is not null)
    or (status <> 'processing' and claim_token is null and lease_until is null)
  ),
  constraint order_outbox_events_lease_epoch_check check (lease_epoch >= 0),
  constraint order_outbox_events_lease_holder_check check (
    lease_holder is null or char_length(lease_holder) between 1 and 160
  ),
  constraint order_outbox_events_published_check check (
    (status = 'published' and published_at is not null)
    or (status <> 'published' and published_at is null)
  ),
  constraint order_outbox_events_error_code_check check (
    last_error_code is null or char_length(last_error_code) between 1 and 120
  ),
  constraint order_outbox_events_error_message_check check (
    sanitized_error_message is null or char_length(sanitized_error_message) <= 2000
  ),
  constraint order_outbox_events_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  )
);

create index order_outbox_events_pending_idx
  on commerce_runtime.order_outbox_events (created_at, id)
  where status = 'pending';
create index order_outbox_events_retry_idx
  on commerce_runtime.order_outbox_events (next_attempt_at, id)
  where status = 'retry_scheduled';
create index order_outbox_events_lease_idx
  on commerce_runtime.order_outbox_events (lease_until, id)
  where status = 'processing';
create index order_outbox_events_order_idx
  on commerce_runtime.order_outbox_events (account_id, order_id);

revoke all on commerce_runtime.order_outbox_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.consumer_inbox — tenant-scoped dedupe for inbound Kafka messages this service
-- consumes. Dedupe alone lives here; the atomic dedupe+mutation pattern is in
-- commerce_runtime.consume_order_event (companion RPC migration, ADR 004 §5.5). This table does
-- not by itself guarantee exactly-once delivery, only exactly-once effect application per message
-- actually delivered to that RPC.
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.consumer_inbox (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  source_topic text not null,
  external_message_id text not null,
  external_message_id_hash text not null,
  order_id uuid,
  payload jsonb not null default '{}'::jsonb,
  correlation_id text,
  consumed_at timestamptz not null default clock_timestamp(),
  constraint consumer_inbox_account_id_id_key unique (account_id, id),
  constraint consumer_inbox_order_fkey foreign key (account_id, order_id)
    references commerce_runtime.orders (account_id, id) on delete restrict,
  constraint consumer_inbox_dedupe_key unique (account_id, source_topic, external_message_id_hash),
  constraint consumer_inbox_source_topic_check check (
    char_length(source_topic) between 1 and 160
  ),
  constraint consumer_inbox_external_id_check check (
    char_length(external_message_id) between 1 and 512
  ),
  constraint consumer_inbox_external_id_hash_check check (
    external_message_id_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint consumer_inbox_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint consumer_inbox_payload_size_check check (octet_length(payload::text) <= 65536),
  constraint consumer_inbox_correlation_check check (
    correlation_id is null or char_length(correlation_id) <= 200
  )
);

create index consumer_inbox_order_idx on commerce_runtime.consumer_inbox (account_id, order_id);

revoke all on commerce_runtime.consumer_inbox from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- commerce_runtime.inventory — operational stock, not the append-only
-- public.commerce_inventory_snapshots observational table (ADR 004 §3.2, §4.6).
-- ---------------------------------------------------------------------------------------------

create table commerce_runtime.inventory (
  account_id uuid not null references public.accounts (id) on delete cascade,
  product_id uuid not null,
  available bigint not null default 0,
  reserved bigint not null default 0,
  version bigint not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint inventory_pkey primary key (account_id, product_id),
  constraint inventory_available_check check (available >= 0),
  constraint inventory_reserved_check check (reserved >= 0),
  constraint inventory_version_check check (version >= 0)
);

revoke all on commerce_runtime.inventory from public, anon, authenticated;

comment on schema commerce_runtime is
  'ADR 004 order service: closed schema, RPC-only access, no direct table grants to any role.';
comment on table commerce_runtime.allowed_order_transitions is
  'FSM legality lookup (composite PK), not an ENUM. new is a birth-transition sentinel from_state only.';
comment on table commerce_runtime.orders is
  'Tenant-scoped idempotent order header. state_version fences every transition/reservation RPC.';
comment on table commerce_runtime.order_transitions is
  'Append-only FSM audit log; mutation is blocked by trigger, not just convention.';
comment on table commerce_runtime.order_outbox_events is
  'Kafka domain-event outbox, partitioned by order_id. Distinct from runtime.outbox_actions.';
comment on table commerce_runtime.consumer_inbox is
  'Tenant-scoped inbound-message dedupe; see commerce_runtime.consume_order_event for the atomic pattern.';
comment on table commerce_runtime.inventory is
  'Operational stock ledger, one row per (account_id, product_id). Not an append-only snapshot.';
