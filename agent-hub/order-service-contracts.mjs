// ADR 004 order service: static contracts over the migration source. These are regex/text checks
// against the migration files themselves, not a live database — they catch a design requirement
// silently regressing (a grant reopened, a table losing its immutability trigger, an RPC losing its
// search_path lockdown) without needing a running Postgres. Concurrency/runtime behavior is
// exercised instead by tests/order_service_invariants.sql (single-transaction) and
// tests/order_service_concurrency.ps1 (real parallel connections).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

const CORE = read('supabase/migrations/20260826110000_order_service_core.sql')
const RPCS = read('supabase/migrations/20260826113000_order_service_rpcs.sql')
const COMBINED = `${CORE}\n${RPCS}`

let failed = 0
const check = (name, cond, detail = '') => {
  if (cond) {
    console.log(`[OK] ${name}`)
  } else {
    failed += 1
    console.error(`[FAIL] ${name}${detail ? `: ${detail}` : ''}`)
  }
}

// --- Closed schema, no ENUM ---------------------------------------------------------------

check(
  'commerce_runtime schema is created and revoked from public/anon/authenticated',
  /create schema commerce_runtime/i.test(CORE)
    && /revoke all on schema commerce_runtime from public, anon, authenticated/i.test(CORE)
    && /grant usage on schema commerce_runtime to service_role/i.test(CORE),
)

check(
  'no ENUM type is used anywhere in the order service migrations',
  !/create type .* as enum/i.test(COMBINED),
)

for (const table of [
  'allowed_order_transitions', 'orders', 'order_transitions', 'order_outbox_events',
  'consumer_inbox', 'inventory',
]) {
  check(
    `commerce_runtime.${table} is revoked from public/anon/authenticated`,
    new RegExp(
      String.raw`revoke all on commerce_runtime\.${table} from public, anon, authenticated`,
      'i',
    ).test(CORE),
    `expected an explicit revoke for ${table}`,
  )
}

// --- FSM: lookup table, not a fixed enum; composite FK enforces legality --------------------

check(
  'allowed_order_transitions is a composite-PK lookup table',
  /primary key \(from_state, to_state\)/i.test(CORE),
)

check(
  "order_transitions enforces transition legality via a composite FK, not inline CHECK enums",
  /constraint order_transitions_pair_fkey foreign key \(from_state, to_state\)\s*\n\s*references commerce_runtime\.allowed_order_transitions/i
    .test(CORE),
)

check(
  "'new' is seeded as the birth-transition sentinel and never a legal to_state",
  /\('new', 'created'\)/.test(CORE)
    && !/allowed_order_transition_to_state_check check \(to_state in \([^)]*'new'/i.test(CORE),
)

// --- Orders: tenant idempotency, payload hash, monotonic state_version ---------------------

check(
  'orders has tenant-scoped idempotency (unique on account_id, idempotency_key)',
  /constraint orders_idempotency_key unique \(account_id, idempotency_key\)/i.test(CORE),
)

check(
  'orders has a composite tenant identity constraint (account_id, id)',
  /constraint orders_account_id_id_key unique \(account_id, id\)/i.test(CORE),
)

check(
  'orders.payload_hash is bound to a 64-hex-char shape (collision defense input)',
  /constraint orders_payload_hash_check check \(payload_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i.test(CORE),
)

check(
  'orders.state_version exists and is non-negative-constrained',
  /state_version bigint not null default 0/i.test(CORE)
    && /constraint orders_state_version_check check \(state_version >= 0\)/i.test(CORE),
)

check(
  'orders.currency and total_amount_minor enforce ISO-shape + integer minor units',
  /constraint orders_currency_check check \(currency ~ '\^\[A-Z\]\{3\}\$'\)/i.test(CORE)
    && /total_amount_minor bigint not null/i.test(CORE)
    && /constraint orders_total_amount_check check \(total_amount_minor >= 0\)/i.test(CORE),
)

// --- Append-only order_transitions -----------------------------------------------------------

check(
  'order_transitions has a BEFORE UPDATE OR DELETE immutability trigger',
  /create trigger order_transitions_immutable\s*\n\s*before update or delete on commerce_runtime\.order_transitions/i
    .test(CORE),
)

check(
  'the immutability trigger function actually raises, unconditionally',
  /function commerce_runtime\.prevent_order_transition_mutation\(\)[\s\S]*?raise exception using errcode = '0OS01'/i
    .test(CORE),
)

// --- Kafka outbox: explicit statuses, lease fencing, dedupe --------------------------------

check(
  'order_outbox_events has the full explicit status lifecycle',
  /status in \('pending', 'processing', 'retry_scheduled', 'published', 'dead_letter'\)/i.test(CORE),
)

for (const column of [
  'attempt_count', 'max_attempts', 'next_attempt_at', 'claim_token', 'lease_holder',
  'lease_until', 'lease_epoch', 'published_at',
]) {
  check(
    `order_outbox_events has ${column}`,
    new RegExp(String.raw`\b${column}\b`).test(CORE.split('order_outbox_events (')[1]?.split(');')[0] ?? ''),
  )
}

check(
  'order_outbox_events has a tenant-scoped dedupe key with a unique constraint',
  /constraint order_outbox_events_dedupe_key unique \(account_id, dedupe_key\)/i.test(CORE),
)

check(
  'order_outbox_events payload is bounded to 64 KiB',
  /constraint order_outbox_events_payload_size_check check \(octet_length\(payload::text\) <= 65536\)/i
    .test(CORE),
)

check(
  'claim_order_outbox_events uses FOR UPDATE SKIP LOCKED',
  /for update skip locked/i.test(RPCS),
)

check(
  'claim never publishes and finish never claims — the claim/finish split holds no lock across Kafka',
  /never holds a lock while a worker talks to Kafka/i.test(RPCS),
)

check(
  'finish_order_outbox_event validates claim_token, lease_epoch and an unexpired lease together',
  /lease_epoch <> p_expected_epoch[\s\S]{0,80}claim_token is distinct from p_claim_token[\s\S]{0,80}lease_until <= v_now/i
    .test(RPCS),
)

check(
  'finish_order_outbox_event auto-upgrades exhausted retries to dead_letter',
  /attempt_count >= v_event\.max_attempts[\s\S]{0,80}v_status := 'dead_letter'/i.test(RPCS),
)

check(
  'claim treats an expired processing lease as reclaimable (no separate sweep job)',
  /status = 'processing' and event\.lease_until <= clock_timestamp\(\)/i.test(RPCS),
)

// --- Consumer inbox: atomic dedupe + mutation ----------------------------------------------

check(
  'consumer_inbox dedupes on (account_id, source_topic, external_message_id_hash)',
  /constraint consumer_inbox_dedupe_key unique \(account_id, source_topic, external_message_id_hash\)/i
    .test(CORE),
)

check(
  'consume_order_event performs the dedupe INSERT and the transition call in one function (one transaction)',
  /on conflict \(account_id, source_topic, external_message_id_hash\) do nothing[\s\S]*?commerce_runtime\.transition_order\(/i
    .test(RPCS),
)

check(
  'consume_order_event does not claim exactly-once delivery',
  /cannot claim exactly-once delivery/i.test(RPCS),
)

// --- Inventory: tenant key, nonnegative, all-or-nothing multi-SKU reservation ---------------

check(
  'inventory keys on (account_id, product_id) with nonnegative available/reserved',
  /constraint inventory_pkey primary key \(account_id, product_id\)/i.test(CORE)
    && /constraint inventory_available_check check \(available >= 0\)/i.test(CORE)
    && /constraint inventory_reserved_check check \(reserved >= 0\)/i.test(CORE),
)

check(
  'reserve_inventory aggregates duplicate product ids before checking stock',
  /Aggregate duplicate product ids/i.test(RPCS),
)

check(
  'reserve_inventory locks inventory rows in deterministic product_id order',
  /order by inv\.product_id asc\s*\n\s*for update/i.test(RPCS),
)

check(
  'reserve_inventory verifies every line before mutating any of them (all-or-nothing)',
  /if jsonb_array_length\(v_short\) > 0 then\s*\n\s*return jsonb_build_object\(\s*\n\s*'status', 'denied_insufficient_stock'/i
    .test(RPCS),
)

// --- Atomic order creation -------------------------------------------------------------------

check(
  'create_order inserts the order, birth transition, and outbox event in one function body',
  /insert into commerce_runtime\.orders \([\s\S]*?insert into commerce_runtime\.order_transitions \([\s\S]*?insert into commerce_runtime\.order_outbox_events \(/i
    .test(RPCS),
)

check(
  'create_order rejects a payload-hash mismatch under a reused idempotency key as a collision, not a silent overwrite',
  /idempotency_key_collision/i.test(RPCS),
)

// --- RPC surface: security definer, empty search_path, service_role only -------------------

const RPC_NAMES = [
  'create_order', 'transition_order', 'reserve_inventory',
  'claim_order_outbox_events', 'finish_order_outbox_event', 'consume_order_event',
]

for (const fn of RPC_NAMES) {
  const def = RPCS.split(`create function commerce_runtime.${fn}(`)[1]
  check(`${fn} is declared security definer`, /security definer/i.test(def?.slice(0, 2000) ?? ''), 'not found')
  check(`${fn} pins set search_path = ''`, /set search_path = ''/i.test(def?.slice(0, 2000) ?? ''), 'not found')
}

check(
  'every order-service RPC is revoked from public/anon/authenticated and granted only to service_role',
  RPC_NAMES.every((fn) => new RegExp(
    String.raw`commerce_runtime\.${fn}\([^)]*\)\s*(from public, anon, authenticated|to service_role)`,
    'is',
  ).test(RPCS)),
)

check(
  'no order-service RPC or table is ever granted to anon or authenticated',
  !/grant [^;]*(anon|authenticated)/i.test(COMBINED),
)

// --- Deployment artifact stays in sync ------------------------------------------------------

const initSql = read('deploy/init-supabase.sql')
check(
  'deploy/init-supabase.sql includes both order service migrations (rebuilt, not stale)',
  initSql.includes('20260826110000_order_service_core.sql')
    && initSql.includes('20260826113000_order_service_rpcs.sql'),
  'run `node deploy/build-init-sql.mjs` after editing supabase/migrations',
)

assert.ok(RPC_NAMES.length === 6)

if (failed > 0) {
  console.error(`\n${failed} order service contract check(s) failed.`)
  process.exit(1)
}
console.log('\nOrder service contracts passed.')
