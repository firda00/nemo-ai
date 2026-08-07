import assert from 'node:assert/strict'
import { normalizeKey } from '../supabase/functions/_shared/providerKey.ts'

// A key arrives wrapped in whatever the seller copied it out of.
const RAW = 'a1b2c3-d4e5f6-9876543210'

assert.equal(normalizeKey(RAW), RAW, 'a clean key is left exactly alone')
assert.equal(normalizeKey(`  ${RAW}\n`), RAW, 'trailing newline from a paste')
assert.equal(normalizeKey(`"${RAW}"`), RAW, 'quotes from a JSON snippet')
assert.equal(normalizeKey(`'${RAW}'`), RAW)

// THE ONE THAT MATTERS. Uzum's OpenAPI wants the raw token and answers a Bearer prefix with 403 —
// the same status it returns when a key genuinely lacks permission. A seller pasting the
// documented curl line would have been told their key cannot read their own shop, and nothing
// would ever have pointed at the two extra words.
assert.equal(normalizeKey(`Bearer ${RAW}`), RAW)
assert.equal(normalizeKey(`bearer ${RAW}`), RAW, 'case as typed, not as documented')
assert.equal(normalizeKey(`Authorization: Bearer ${RAW}`), RAW, 'the whole header line pasted')
assert.equal(normalizeKey(`"Bearer ${RAW}"`), RAW, 'quoted header value')

// Hyphens are part of the key and must survive. An earlier draft of the zero-width class was
// written as a range and stripped every hyphen instead — the key stayed plausible and stopped
// working.
assert.ok(normalizeKey(RAW).includes('-'), 'hyphens are key material, not decoration')
assert.equal(normalizeKey(RAW).split('-').length, 3)

// Zero-width characters a web page leaves behind.
const ZWSP = String.fromCharCode(0x200b)
const BOM = String.fromCharCode(0xfeff)
assert.equal(normalizeKey(`${BOM}${RAW}${ZWSP}`), RAW)

// Nothing at all is an empty string, never the word "undefined".
assert.equal(normalizeKey(undefined), '')
assert.equal(normalizeKey(null), '')
assert.equal(normalizeKey(''), '')

// A key that is only wrapping is empty, so the format check refuses it instead of storing "".
assert.equal(normalizeKey('Bearer '), '')

console.log('[OK] Onboarding key normalisation: 15 assertions')
