import assert from 'node:assert/strict'
import {
  AmoApiError,
  AmoEnrichmentClient,
  parseAmoCredential,
} from './amocrm/enrichment-client.ts'
import { normalizeDealStageChanged } from './amocrm/normalizer.ts'
import { processAmoClaim } from './workers/amocrm-enrichment.ts'
import {
  providerSecretContext,
  sealSecret,
} from '../supabase/functions/_shared/secretBox.ts'

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64')

assert.deepEqual(parseAmoCredential('tenant.amocrm.com|token-value'), {
  host: 'tenant.amocrm.com', accessToken: 'token-value',
})
assert.throws(() => parseAmoCredential('evil.example|token'), /AMOCRM_DOMAIN_NOT_ALLOWED/)

let request
const client = new AmoEnrichmentClient(parseAmoCredential('tenant|token'), {
  fetcher: async (url, init) => {
    request = { url: String(url), init }
    return new Response(JSON.stringify({ id: 42 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  },
})
assert.equal((await client.getLead('42')).id, 42)
assert.equal(request.url, 'https://tenant.amocrm.ru/api/v4/leads/42?with=contacts')
assert.equal(request.init.method, 'GET')
assert.equal(request.init.redirect, 'manual')

const redirected = new AmoEnrichmentClient(parseAmoCredential('tenant|token'), {
  fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
})
await assert.rejects(() => redirected.getLead('42'), (error) => error instanceof AmoApiError
  && error.code === 'AMOCRM_REDIRECT_BLOCKED')

const limited = new AmoEnrichmentClient(parseAmoCredential('tenant|token'), {
  jitter: () => 0.5,
  fetcher: async () => new Response(null, { status: 429, headers: { 'retry-after': '2' } }),
})
await assert.rejects(() => limited.getLead('42'), (error) => error instanceof AmoApiError
  && error.code === 'AMOCRM_RATE_LIMITED' && error.retryAfterMs === 2500)

const normalized = normalizeDealStageChanged({
  accountId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  eventType: 'DEAL_STAGE_CHANGED',
  externalDealId: '42',
  lead: { id: 42, pipeline_id: 7, status_id: 13, updated_at: 1_787_488_000 },
  contact: {
    id: 9, name: 'Client',
    custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+998 (90) 111-22-33' }] }],
  },
})
assert.equal(normalized.contactPhone, '+998901112233')
assert.equal(normalized.eventType, 'DEAL_STAGE_CHANGED')

function claim(overrides = {}) {
  return {
    account_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    workflow_id: '11111111-2222-4333-8444-555555555555',
    inbox_event_id: '22222222-3333-4444-8555-666666666666',
    workflow_type: 'amocrm_native_enrichment', workflow_version: '1.0.0',
    execution_mode: 'shadow', correlation_id: '33333333-4444-4555-8666-777777777777',
    claim_token: '44444444-5555-4666-8777-888888888888', lease_epoch: 1,
    lease_until: new Date(Date.now() + 60_000).toISOString(), attempt_count: 1,
    context: {}, event_type: 'DEAL_STAGE_CHANGED',
    payload: { external_entity_id: '42' },
    ...overrides,
  }
}

const transitions = []
const runtime = {
  async acquireConnectorPermit() { return { allowed: true, state: 'closed', permit_token: 'permit-1' } },
  async recordConnectorSuccess(input) { transitions.push(['success', input]); return {} },
  async recordConnectorFailure(input) { transitions.push(['failure', input]); return {} },
  async checkpointAndTransition(input) { transitions.push(['checkpoint', input]); return {} },
  async transitionWorkflow(input) { transitions.push(['transition', input]); return {} },
}
const encryptedCredential = await sealSecret(
  'tenant.amocrm.ru|token-value',
  providerSecretContext(claim().account_id, 'amocrm'),
)
const keyStore = {
  from() {
    return { select: () => ({ eq: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { api_key: encryptedCredential }, error: null }),
    }) }) }) }
  },
}
const outcome = await processAmoClaim(claim(), {
  runtime,
  keyStore,
  clientFactory: () => ({
    async getLead() {
      return { id: 42, pipeline_id: 7, status_id: 13, updated_at: 1_787_488_000, _embedded: { contacts: [{ id: 9 }] } }
    },
    async getContact() {
      return { id: 9, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+998901112233' }] }] }
    },
  }),
})
assert.equal(outcome, 'checkpointed')
assert.equal(transitions.some(([kind]) => kind === 'checkpoint'), true)

transitions.length = 0
const unsupported = await processAmoClaim(claim({ event_type: 'NEW_CONTACT_CREATED' }), { runtime, keyStore })
assert.equal(unsupported, 'dead_letter')
assert.equal(transitions[0][1].terminalReasonCode, 'UNSUPPORTED_EVENT_TYPE')

console.log('amoCRM enrichment behavior passed: allowlist, redirect block, 429 jitter, normalization, and shadow fencing.')
