import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync('supabase/migrations/20260826120000_durable_a2a_inbox_outbox.sql', 'utf8')
const supervisor = readFileSync('agent-hub/orchestration/subagent-supervisor.ts', 'utf8')
const wire = readFileSync('src/types/a2a-wire.ts', 'utf8')

const checks = [
  ['tenant/workflow/message idempotency is enforced in both queues',
    (migration.match(/unique \(account_id, workflow_id, message_id\)/g) ?? []).length === 2],
  ['both queues use tenant-safe workflow foreign keys',
    (migration.match(/foreign key \(account_id, workflow_id\)/g) ?? []).length === 2],
  ['browser roles cannot access A2A tables or RPC',
    /revoke all on runtime\.a2a_outbox_messages, runtime\.a2a_inbox_messages from public, anon, authenticated/.test(migration)
      && (migration.match(/from public, anon, authenticated/g) ?? []).length >= 7],
  ['all public A2A RPCs are security definers with empty search paths',
    (migration.match(/create function public\.runtime_[a-z0-9_]+/g) ?? []).length === 6
      && (migration.match(/security definer\s+set search_path = ''/g) ?? []).length === 6],
  ['claims use SKIP LOCKED and leases',
    (migration.match(/for update skip locked/g) ?? []).length === 2
      && migration.includes("status = 'delivering'") && migration.includes("status = 'processing'")],
  ['outbox enqueue is fenced by workflow token, epoch and lease',
    /v_run\.lease_epoch <> p_expected_epoch/.test(migration)
      && /v_run\.claim_token <> p_claim_token/.test(migration)
      && /v_run\.lease_until <= clock_timestamp\(\)/.test(migration)],
  ['inbox requires matching fenced outbox proof',
    /a2a source proof rejected/.test(migration) && /sent\.message_hash = v_hash/.test(migration)],
  ['inbox claim is recipient scoped',
    /item\.to_agent_id = p_to_agent_id/.test(migration)],
  ['database rejects secret-bearing message keys',
    (migration.match(/no_secret_keys_check/g) ?? []).length === 2],
  ['supervisor sends only compact A2A dependency envelopes',
    supervisor.includes('compactDependencies')
      && supervisor.includes('output: {')
      && supervisor.includes("if (key !== '_a2a')")],
  ['wire decoder rejects oversized input before JSON parsing',
    wire.indexOf('bytes.byteLength > A2A_MAX_MESSAGE_BYTES') < wire.indexOf('JSON.parse')],
]

for (const [name, passed] of checks) {
  assert.equal(passed, true, name)
  console.log(`[PASS] ${name}`)
}
console.log(`Durable A2A contracts: ${checks.length} PASS`)
