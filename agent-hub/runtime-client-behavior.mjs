import assert from 'node:assert/strict'
import {
  RuntimeClient,
  RuntimeRpcError,
} from '../supabase/functions/_shared/runtime.ts'
import { ingestCrmEventInShadow } from '../supabase/functions/_shared/runtimeCrm.ts'

let checks = 0
const checkAsync = async (fn) => { await fn(); checks++ }

function transport(handler) {
  const calls = []
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args })
      return handler(name, args)
    },
  }
}

await checkAsync(async () => {
  const wire = transport(async () => ({
    data: {
      status: 'created',
      workflow_id: '11111111-2222-4333-8444-555555555555',
      inbox_event_id: '22222222-3333-4444-8555-666666666666',
    },
    error: null,
  }))
  const result = await new RuntimeClient(wire).ingestEvent({
    accountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    provider: 'amocrm',
    externalEventId: 'AMOCRM:INBOUND:DEAL_STAGE_CHANGED:42',
    payload: { lead: 42 },
    executionMode: 'shadow',
    correlationId: '33333333-4444-4555-8666-777777777777',
  })
  assert.equal(result.status, 'created')
  assert.equal(wire.calls[0].name, 'runtime_ingest_event')
  assert.equal(wire.calls[0].args.p_execution_mode, 'shadow')
  assert.equal(wire.calls[0].args.p_external_event_id, 'AMOCRM:INBOUND:DEAL_STAGE_CHANGED:42')
})

await checkAsync(async () => {
  const wire = transport(async (name) => name === 'runtime_claim_workflow'
    ? { data: [], error: null }
    : { data: null, error: null })
  const rows = await new RuntimeClient(wire).claimWorkflows({ workerId: 'worker-1', limit: 10 })
  assert.deepEqual(rows, [])
  assert.equal(wire.calls[0].args.p_lease_duration_seconds, 300)
  assert.equal(wire.calls[0].args.p_execution_mode, null)
})

await checkAsync(async () => {
  const wire = transport(async () => ({ data: null, error: { code: '55000', message: 'raw SQL detail' } }))
  await assert.rejects(
    () => new RuntimeClient(wire).ingestEvent({
      accountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      provider: 'amocrm', externalEventId: 'event', payload: {}, executionMode: 'shadow',
      correlationId: '33333333-4444-4555-8666-777777777777',
    }),
    (error) => error instanceof RuntimeRpcError
      && error.code === '55000'
      && !error.message.includes('raw SQL detail'),
  )
})

await checkAsync(async () => {
  const wire = transport(async () => ({ data: null, error: null }))
  await assert.rejects(
    () => new RuntimeClient(wire).claimOutboxActions({ workerId: 'outbox-1' }),
    (error) => error instanceof RuntimeRpcError && error.code === 'INVALID_RPC_RESULT',
  )
})

await checkAsync(async () => {
  const wire = transport(async () => ({
    data: {
      status: 'created',
      workflow_id: '11111111-2222-4333-8444-555555555555',
      inbox_event_id: '22222222-3333-4444-8555-666666666666',
    },
    error: null,
  }))
  await ingestCrmEventInShadow(new RuntimeClient(wire), {
    idempotencyKey: 'AMOCRM:INBOUND:DEAL_STAGE_CHANGED:42:2026-08-17T10_00_00Z',
    correlationId: '33333333-4444-4555-8666-777777777777',
    event: {
      tenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      provider: 'AMOCRM',
      eventType: 'DEAL_STAGE_CHANGED',
      externalDealId: '42',
      contactPhone: '+998901112233',
      pipelineId: '7',
      statusId: '13',
      customFields: {},
      occurredAt: '2026-08-17T10:00:00Z',
    },
  })
  const args = wire.calls[0].args
  assert.equal(args.p_provider, 'amocrm')
  assert.equal(args.p_execution_mode, 'shadow')
  assert.equal(args.p_contract_version, 'unified-crm-v5')
  assert.equal(args.p_identity_version, 'crm-idempotency-v1')
  assert.equal(args.p_workflow_type, 'amocrm_shadow_event')
  assert.equal(args.p_external_event_id.includes('DEAL_STAGE_CHANGED'), true)
})

console.log(`Runtime client behavior: ${checks}/${checks}`)
