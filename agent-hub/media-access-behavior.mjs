// Mocked behavioral tests for resolveMediaAccess routing:
//   • default image/video routing stays on OpenRouter (a stored unrelated key never reroutes),
//   • direct adapters are explicit opt-in via acceptedProviders,
//   • the provider_keys read is tenant- and provider-scoped,
//   • DB read / decryption failures fail closed with NO paid shared-key fallback,
//   • a corrupt key for an unaccepted provider cannot affect the request.
// No network, no Supabase: the admin client is a recording mock.
import assert from 'node:assert/strict'

process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

const { resolveMediaAccess } = await import('../supabase/functions/_shared/mediaAccess.ts')
const { providerSecretContext, sealSecret } = await import('../supabase/functions/_shared/secretBox.ts')

const ACCOUNT = 'account-a'
const OTHER_ACCOUNT = 'account-b'
const paidPlan = { media: true, video: true, mediaIncluded: false, mediaMonthly: 0, mediaTrialWeekly: 0 }
const includedPlan = { ...paidPlan, mediaIncluded: true, mediaMonthly: 100 }

const seal = (provider, value, account = ACCOUNT) => sealSecret(value, providerSecretContext(account, provider))

// admin mock: records every provider_keys query; only .in() resolves, like the real chain
function mockAdmin(rowsByAccount, { failKeys = false } = {}) {
  const queries = []
  return {
    queries,
    from(table) {
      const q = { table, eq: {}, in: null }
      const builder = {
        select() { return builder },
        eq(col, val) { q.eq[col] = val; return builder },
        in(col, vals) {
          q.in = { col, vals }
          queries.push(q)
          if (failKeys) return Promise.resolve({ data: null, error: { code: '57014' } })
          const rows = (rowsByAccount[q.eq.account_id] ?? []).filter((r) => vals.includes(r.provider))
          return Promise.resolve({ data: rows.map(({ provider, api_key }) => ({ provider, api_key })), error: null })
        },
      }
      return builder
    },
  }
}

const rows = {
  [ACCOUNT]: [
    { provider: 'openrouter', api_key: await seal('openrouter', 'or-key-a') },
    { provider: 'openai', api_key: await seal('openai', 'oa-key-a') },
    { provider: 'replicate', api_key: await seal('replicate', 'rp-key-a') },
  ],
}

// 1) default image routing: OpenRouter wins even though an OpenAI key is stored,
//    and the DB read is scoped to the accepted provider + tenant
{
  const admin = mockAdmin(rows)
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'image', 'nemo-shared', false)
  assert.equal(access.ok, true)
  assert.equal(access.source, 'byo')
  assert.equal(access.provider, 'openrouter')
  assert.equal(access.key, 'or-key-a')
  assert.equal(admin.queries.length, 1)
  assert.deepEqual(admin.queries[0].in.vals, ['openrouter'], 'image default must query openrouter rows only')
  assert.equal(admin.queries[0].eq.account_id, ACCOUNT, 'key lookup must be tenant-scoped')
}

// 2) default video routing: a stored Replicate key must NOT reroute the default
{
  const admin = mockAdmin(rows)
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'video', 'nemo-shared', false)
  assert.equal(access.provider, 'openrouter')
  assert.deepEqual(admin.queries[0].in.vals, ['openrouter'], 'video default must query openrouter rows only')
}

// 3) an account with ONLY an unrelated OpenAI key gets no BYO route by default
{
  const admin = mockAdmin({ [ACCOUNT]: rows[ACCOUNT].filter((r) => r.provider === 'openai') })
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'image', '', false)
  assert.equal(access.ok, false)
  assert.equal(access.code, 'NEED_KEY', 'unrelated openai key must not hijack the default route')
}

// 4) direct opt-in: explicit acceptedProviders selects the direct adapter key
{
  const admin = mockAdmin(rows)
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'image', '', false, ['openai'])
  assert.equal(access.ok, true)
  assert.equal(access.provider, 'openai')
  assert.equal(access.key, 'oa-key-a')
  assert.deepEqual(admin.queries[0].in.vals, ['openai'])
}
{
  const admin = mockAdmin(rows)
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'video', '', false, ['replicate'])
  assert.equal(access.provider, 'replicate')
  assert.equal(access.key, 'rp-key-a')
}

// 5) acceptedProviders can only narrow, never widen: unknown/foreign providers are
//    dropped and, with nothing accepted and no shared key, access fails without any query
{
  const admin = mockAdmin(rows)
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'image', '', false, ['replicate', 'uzum'])
  assert.equal(access.ok, false)
  assert.equal(access.code, 'NEED_KEY')
  assert.equal(admin.queries.length, 0, 'no provider_keys read may happen for unaccepted providers')
}

// 6) failed DB read fails closed — even an included plan must NOT fall through to Nemo's paid key
{
  const admin = mockAdmin(rows, { failKeys: true })
  const access = await resolveMediaAccess(admin, ACCOUNT, includedPlan, 'video', 'nemo-shared', false)
  assert.equal(access.ok, false)
  assert.equal(access.code, 'ERROR', 'DB error must not silently bill the shared key')
}

// 7) a corrupt key for an UNACCEPTED provider never affects the request
{
  const admin = mockAdmin({
    [ACCOUNT]: [
      { provider: 'openrouter', api_key: await seal('openrouter', 'or-key-a') },
      { provider: 'openai', api_key: 'enc:v2:bad:bad' },
    ],
  })
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'image', '', false)
  assert.equal(access.ok, true)
  assert.equal(access.provider, 'openrouter')
}

// 8) a corrupt SELECTED key fails closed instead of silently billing the shared key
{
  const admin = mockAdmin({ [ACCOUNT]: [{ provider: 'openai', api_key: 'enc:v2:bad:bad' }] })
  const access = await resolveMediaAccess(admin, ACCOUNT, includedPlan, 'image', 'nemo-shared', false, ['openai'])
  assert.equal(access.ok, false)
  assert.equal(access.code, 'ERROR')
}

// 9) tenant isolation via context binding: ciphertext copied from another account fails closed
{
  const stolen = await seal('openrouter', 'or-key-b', OTHER_ACCOUNT)
  const admin = mockAdmin({ [ACCOUNT]: [{ provider: 'openrouter', api_key: stolen }] })
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'image', 'nemo-shared', false)
  assert.equal(access.ok, false)
  assert.equal(access.code, 'ERROR', 'cross-tenant ciphertext must not decrypt')
}

// 10) voice keeps its historical multi-provider default (backward compatibility)
{
  const admin = mockAdmin({ [ACCOUNT]: [{ provider: 'elevenlabs', api_key: await seal('elevenlabs', 'el-key-a') }] })
  const access = await resolveMediaAccess(admin, ACCOUNT, paidPlan, 'voice', '', false)
  assert.equal(access.provider, 'elevenlabs')
  assert.equal(access.key, 'el-key-a')
}

console.log('Media access routing behavior passed.')
