import assert from 'node:assert/strict'

const key = Buffer.alloc(32, 7).toString('base64')
globalThis.Deno = { env: { get: (name) => name === 'CREDENTIAL_ENCRYPTION_KEY' ? key : undefined } }

const {
  openSecret,
  providerSecretContext,
  sealSecret,
} = await import('../supabase/functions/_shared/secretBox.ts')

const context = providerSecretContext('account-a', 'uzum')
const sealed = await sealSecret('seller-token-value', context)
assert.match(sealed, /^enc:v2:/)
assert.equal(await openSecret(sealed, context), 'seller-token-value')

const prefixLookingInput = 'enc:v2:not-a-real-iv:not-a-real-ciphertext'
const resealedPrefixInput = await sealSecret(prefixLookingInput, context)
assert.notEqual(resealedPrefixInput, prefixLookingInput, 'ciphertext-looking input must still be encrypted')
assert.equal(await openSecret(resealedPrefixInput, context), prefixLookingInput)

await assert.rejects(
  openSecret(sealed, providerSecretContext('account-b', 'uzum')),
  'moving ciphertext to another account must fail authentication',
)
await assert.rejects(
  openSecret(sealed, providerSecretContext('account-a', 'kaspi')),
  'using ciphertext as another provider must fail authentication',
)
await assert.rejects(
  openSecret(sealed),
  /Credential context is required/,
  'v2 credentials must never decrypt without their tenant/provider context',
)

const legacy = await sealSecret('legacy-compatible')
assert.match(legacy, /^enc:v1:/)
assert.equal(await openSecret(legacy), 'legacy-compatible')

console.log('Secret box behavior passed: v2 credentials are tenant/provider-bound and v1 remains readable.')
