import assert from 'node:assert/strict'
import {
  A2A_MAX_MESSAGE_BYTES,
  A2AMessageSchema,
  A2AProtocolError,
  buildA2AIdempotencyKey,
  decodeA2AMessage,
  encodeA2AMessage,
} from '../src/types/a2a-wire.ts'
import { SubagentSupervisor, type SubagentExecutor } from '../agent-hub/orchestration/subagent-supervisor.ts'

const accountId = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const workflowId = '01917b12-3a5c-7d9e-bf33-9118c7e7b802'
const messageId = '01917b12-3a5c-7d9e-bf33-9118c7e7b803'

const validMessage = {
  version: '1.0',
  message_id: messageId,
  account_id: accountId,
  workflow_id: workflowId,
  from_agent_id: 'finance-analyst',
  to_agent_id: 'proposal-writer',
  intent: 'result',
  created_at: '2026-08-26T10:00:00+05:00',
  sender_lease_epoch: 7,
  summary: 'Estimate calculated from the approved tenant price list.',
  data: { total_minor: 125_000, currency: 'UZS' },
  evidence_refs: [{ evidence_id: 'price-list-v4', source_type: 'tenant_record', sha256: 'a'.repeat(64) }],
  artifact_refs: [],
  confidence: 0.98,
  requires_approval: false,
} as const

const parsed = A2AMessageSchema.parse(validMessage)
assert.equal(parsed.version, '1.0')
assert.equal(parsed.data.currency, 'UZS')

const encoded = encodeA2AMessage(validMessage)
assert.deepEqual(decodeA2AMessage(encoded), parsed)
assert.equal(encodeA2AMessage(validMessage), encoded, 'canonical encoding must be deterministic')
assert.equal(
  buildA2AIdempotencyKey(parsed),
  `${accountId}:${workflowId}:${messageId}`,
  'idempotency must be tenant and workflow scoped',
)

assert.throws(
  () => decodeA2AMessage(`{"payload":"${'x'.repeat(A2A_MAX_MESSAGE_BYTES)}"}`),
  (error: unknown) => error instanceof A2AProtocolError && error.code === 'A2A_MESSAGE_TOO_LARGE',
)
assert.throws(
  () => decodeA2AMessage('{broken'),
  (error: unknown) => error instanceof A2AProtocolError && error.code === 'A2A_INVALID_JSON',
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, data: { api_key: 'must-not-cross-agent-boundaries' } }),
  /prohibited/i,
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, summary: `Use Bearer ${'x'.repeat(32)}` }),
  /secret-like/i,
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, evidence_refs: [], artifact_refs: [] }),
  /requires evidence_refs or artifact_refs/i,
)
assert.throws(
  () => A2AMessageSchema.parse({
    ...validMessage,
    artifact_refs: [{
      artifact_id: '01917b12-3a5c-7d9e-bf33-9118c7e7b804',
      kind: 'document',
      sha256: 'b'.repeat(64),
      storage_path: 'tenants/01917b12-3a5c-7d9e-bf33-9118c7e7b999/artifacts/report.pdf',
    }],
  }),
  /belong to the message tenant/i,
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, intent: 'approval_request', requires_approval: false }),
  /must require approval/i,
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, to_agent_id: validMessage.from_agent_id }),
  /sender and recipient must differ/i,
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, message_id: '01917b12-3a5c-4d9e-bf33-9118c7e7b803' }),
  /UUIDv7/i,
)
assert.throws(
  () => A2AMessageSchema.parse({ ...validMessage, unexpected: true }),
  /Unrecognized key/i,
)

const dispatched: Array<{ message: unknown; idempotencyKey: string }> = []
let dependencySeenByWriter: Record<string, unknown> | undefined
const executor: SubagentExecutor = async (task) => {
  if (task.id === 'finance') {
    return {
      privateScratch: 'must not be forwarded to another agent',
      total: 125_000,
      _a2a: {
        summary: 'Estimate calculated from tenant-approved prices.',
        data: { total_minor: 125_000, currency: 'UZS' },
        evidence_refs: [{ evidence_id: 'price-list-v4', source_type: 'tenant_record', sha256: 'a'.repeat(64) }],
      },
    }
  }
  dependencySeenByWriter = task.dependencies.finance.output
  return { proposalReady: true }
}
const supervised = await new SubagentSupervisor(executor, {
  a2a: {
    accountId,
    workflowId,
    senderLeaseEpoch: 7,
    messageIdForEdge: () => '01917b12-3a5c-7d9e-bf33-9118c7e7b805',
    now: () => '2026-08-26T10:00:00+05:00',
    enqueue: async (message, idempotencyKey) => { dispatched.push({ message, idempotencyKey }) },
  },
}).run([
  { id: 'finance', role: 'FINANCE_ANALYST', input: {} },
  { id: 'proposal', role: 'MARKETER', input: {}, dependsOn: ['finance'] },
])
assert.equal(dispatched.length, 1)
assert.equal(dispatched[0].idempotencyKey, `${accountId}:${workflowId}:01917b12-3a5c-7d9e-bf33-9118c7e7b805`)
assert.equal(dependencySeenByWriter?.privateScratch, undefined, 'A2A must not forward a branch scratchpad')
assert.equal((dependencySeenByWriter?.data as Record<string, unknown>).total_minor, 125_000)
assert.equal(supervised.merged._a2a, undefined, 'wire envelopes must not leak into the final artifact')
assert.equal(supervised.merged.proposalReady, true)

const invalidA2A = await new SubagentSupervisor(async (task) => (
  task.id === 'source' ? { raw: 'no compact handoff' } : { shouldNotRun: true }
), {
  a2a: {
    accountId,
    workflowId,
    senderLeaseEpoch: 7,
    messageIdForEdge: () => '01917b12-3a5c-7d9e-bf33-9118c7e7b806',
    enqueue: async () => undefined,
  },
}).run([
  { id: 'source', role: 'FINANCE_ANALYST', input: {} },
  { id: 'target', role: 'MARKETER', input: {}, dependsOn: ['source'] },
])
assert.equal(invalidA2A.branches[1].errorCode, 'SUBAGENT_A2A_INVALID')

console.log('A2A Wire Protocol: 19 invariants passed')
