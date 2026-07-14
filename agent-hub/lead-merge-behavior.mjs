// Offline behavior gate for the lead-patch sanitizer used by the concurrent-safe
// lead pipeline (security gate #29). SQL-side merge/claim semantics are verified
// live by deploy.ps1's leads probe and security-live-smoke.mjs.
import assert from 'node:assert/strict'
import { buildLeadKeys, sanitizeLeadPatch, MAX_LEAD_KEYS, MAX_LEAD_VALUE_CHARS } from '../supabase/functions/_shared/leadPatch.ts'

let count = 0
const step = (fn) => { fn(); count++ }

// allowlist construction
step(() => assert.deepEqual(buildLeadKeys(), ['name', 'phone', 'email', 'request', 'budget'], 'core contact fields are always allowed'))
step(() => assert.ok(buildLeadKeys(['курс']).includes('курс'), 'agent-configured lead-form fields are captured'))
step(() => assert.equal(buildLeadKeys(['курс', ' курс ', '']).filter((k) => k === 'курс').length, 1, 'duplicates, padding and empties collapse'))
step(() => assert.deepEqual(
  buildLeadKeys(['crm_pushed', 'CRM_Pushed', 'crm_push_claimed_at', 'crm_push_claim', '__proto__', 'prototype', 'constructor', 'course']),
  ['name', 'phone', 'email', 'request', 'budget', 'course'],
  'reserved CRM-claim and prototype names never become allowed keys',
))
step(() => assert.equal(buildLeadKeys(Array.from({ length: 30 }, (_, i) => `f${i}`)).length, MAX_LEAD_KEYS, 'allowlist is capped'))

// patch sanitization
const keys = buildLeadKeys(['course'])
step(() => assert.deepEqual(
  sanitizeLeadPatch({ name: '  Aziz ', phone: '+998 90 123-45-67', email: 'aziz@example.com', course: 'IELTS', request: null, budget: 'null', extra: 'dropped' }, keys),
  { name: 'Aziz', phone: '+998 90 123-45-67', email: 'aziz@example.com', course: 'IELTS' },
  'only explicitly stated allowed keys survive',
))
step(() => assert.equal(sanitizeLeadPatch({ phone: 'тот же номер' }, keys).phone, undefined, 'non-numeric phone is rejected'))
step(() => assert.equal(sanitizeLeadPatch({ phone: '1234' }, keys).phone, undefined, 'too-short phone is rejected'))
step(() => assert.equal(sanitizeLeadPatch({ email: 'not-an-email' }, keys).email, undefined, 'malformed email is rejected'))
step(() => assert.equal(sanitizeLeadPatch({ name: 'x'.repeat(1000) }, keys).name.length, MAX_LEAD_VALUE_CHARS, 'values are bounded'))
step(() => assert.deepEqual(sanitizeLeadPatch('not an object', keys), {}, 'non-object extraction yields an empty patch'))
step(() => assert.deepEqual(sanitizeLeadPatch(['array'], keys), {}, 'array extraction yields an empty patch'))

// prototype-pollution safety: a hostile extraction (or a hostile lead-form label
// passed straight into the keys argument) must never poison Object.prototype or
// smuggle reserved keys into the stored patch.
const polluted = sanitizeLeadPatch(JSON.parse('{"__proto__": {"polluted": "yes"}, "constructor": "x", "crm_pushed": "fake", "name": "Aziz"}'), [...keys, '__proto__', 'constructor', 'crm_pushed'])
step(() => assert.equal(polluted.name, 'Aziz', 'legitimate keys still survive a hostile payload'))
step(() => assert.equal({}.polluted, undefined, 'Object.prototype is not polluted'))
step(() => assert.equal(Object.keys(polluted).some((k) => k !== 'name'), false, 'reserved keys never survive even when passed as allowed keys'))
step(() => assert.deepEqual(sanitizeLeadPatch(Object.create({ name: 'ghost' }), keys), {}, 'inherited properties are not treated as stated values'))

console.log(`Lead patch behavior: ${count}/${count} assertions passed.`)
