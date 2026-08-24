import assert from 'node:assert/strict'
import {
  AmoWebhookParseError,
  ingestNativeAmoWebhook,
  parseAmoFormBody,
  parseNativeAmoWebhook,
} from './server/amocrm-native.ts'

let checks = 0
const check = (fn) => { fn(); checks += 1 }
const checkAsync = async (fn) => { await fn(); checks += 1 }

const form = (overrides = {}) => new URLSearchParams({
  'account[subdomain]': 'nemo-test',
  'account[id]': '7001',
  'leads[status][0][id]': '42',
  'leads[status][0][pipeline_id]': '7',
  'leads[status][0][status_id]': '13',
  'leads[status][0][last_modified]': '1787565600',
  ...overrides,
}).toString()

check(() => {
  const parsed = parseNativeAmoWebhook(form(), new Date('2026-08-24T00:00:00Z'))
  assert.equal(parsed.accountSubdomain, 'nemo-test')
  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.events[0].eventType, 'DEAL_STAGE_CHANGED')
  assert.equal(parsed.events[0].externalEntityId, '42')
  assert.equal(parsed.events[0].payload.needs_enrichment, true)
})

check(() => {
  const parsed = parseNativeAmoWebhook(new URLSearchParams({
    'account[subdomain]': 'https://nemo-test.amocrm.ru/',
    'contacts[add][0][id]': '99',
    'contacts[add][0][name]': 'Test Contact',
    'contacts[add][0][custom_fields][0][code]': 'PHONE',
    'contacts[add][0][custom_fields][0][values][0][value]': '+998901112233',
  }).toString())
  assert.equal(parsed.accountSubdomain, 'nemo-test')
  assert.equal(parsed.events[0].eventType, 'NEW_CONTACT_CREATED')
})

check(() => {
  const first = parseNativeAmoWebhook(form()).events[0]
  const retry = parseNativeAmoWebhook(form()).events[0]
  const changed = parseNativeAmoWebhook(form({ 'leads[status][0][status_id]': '14' })).events[0]
  assert.equal(first.externalEventId, retry.externalEventId, 'provider retry must preserve identity')
  assert.notEqual(first.externalEventId, changed.externalEventId, 'a real state change must not collapse')
})

check(() => {
  assert.throws(
    () => parseAmoFormBody('account[subdomain]=ok&account[subdomain]=other'),
    (error) => error instanceof AmoWebhookParseError && error.code === 'duplicate_form_field',
  )
})

check(() => {
  assert.throws(
    () => parseAmoFormBody('__proto__[polluted]=yes'),
    (error) => error instanceof AmoWebhookParseError && error.code === 'unsafe_form_key',
  )
  assert.equal({}.polluted, undefined)
})

check(() => {
  assert.throws(
    () => parseNativeAmoWebhook('account[subdomain]=nemo-test'),
    (error) => error instanceof AmoWebhookParseError && error.code === 'no_supported_events',
  )
})

await checkAsync(async () => {
  const calls = []
  const runtime = {
    async ingestEvent(input) {
      calls.push(input)
      return { status: 'created', workflow_id: 'workflow', inbox_event_id: 'inbox' }
    },
  }
  const parsed = parseNativeAmoWebhook(form())
  const results = await ingestNativeAmoWebhook(runtime, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', parsed)
  assert.equal(results.length, 1)
  assert.equal(calls[0].executionMode, 'shadow')
  assert.equal(calls[0].workflowType, 'amocrm_native_enrichment')
  assert.equal(calls[0].identityVersion, 'amocrm-native-payload-v1')
})

console.log(`[OK] Native amoCRM webhook behavior: ${checks}/${checks}`)
