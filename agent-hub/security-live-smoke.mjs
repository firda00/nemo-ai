// Isolated live tenant-security smoke. Creates two temporary accounts, verifies
// cross-tenant denial/races/cascades/rate limits, then deletes all test data.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const line of fs.readFileSync(path.join(root, '.secrets.local'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([^#][A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
}
const ref = process.env.SUPABASE_PROJECT_REF
const serviceKey = process.env.SUPABASE_SECRET_KEY
const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY
if (!ref || !serviceKey || !anonKey) throw new Error('Missing isolated-test Supabase configuration')
const url = `https://${ref}.supabase.co`
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const password = `Nemo!${crypto.randomUUID()}aA1`
const users = []
const accounts = []
let failed = 0
const report = []
const ok = (name, condition, detail = '') => {
  report.push({ name, ok: Boolean(condition), detail })
  console.log(`[${condition ? 'OK' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failed++
}

async function makeUser(label) {
  const email = `security-${label}-${stamp}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw error ?? new Error('createUser failed')
  users.push(data.user.id)
  const { data: profile, error: pe } = await admin.from('users').select('account_id').eq('id', data.user.id).single()
  if (pe || !profile?.account_id) throw pe ?? new Error('profile missing')
  accounts.push(profile.account_id)
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: session, error: se } = await client.auth.signInWithPassword({ email, password })
  if (se || !session.session) throw se ?? new Error('signin failed')
  return { id: data.user.id, accountId: profile.account_id, client, jwt: session.session.access_token }
}

try {
  const a = await makeUser('a')
  const b = await makeUser('b')
  const { data: agentB, error: agentErr } = await b.client.from('agents').insert({ name: 'Tenant B secret agent' }).select('id').single()
  if (agentErr || !agentB) throw agentErr ?? new Error('agent B missing')
  const { data: docB, error: docErr } = await b.client.from('knowledge_docs').insert({ owner_type: 'agent', owner_id: agentB.id, source: 'faq', name: 'private', content: 'TENANT_B_SECRET' }).select('id').single()
  if (docErr || !docB) throw docErr ?? new Error('doc B missing')
  await admin.from('business_profiles').upsert({ account_id: b.accountId, name: 'Tenant B private CRM', extra: 'PRIVATE_CRM_VALUE' })

  const foreignAgent = await a.client.from('agents').select('id').eq('id', agentB.id)
  ok('RLS blocks foreign agent by direct ID', !foreignAgent.error && (foreignAgent.data ?? []).length === 0)
  const foreignDoc = await a.client.from('knowledge_docs').select('content').eq('id', docB.id)
  ok('RLS blocks foreign RAG document by direct ID', !foreignDoc.error && (foreignDoc.data ?? []).length === 0)
  const foreignCrm = await a.client.from('business_profiles').select('*').eq('account_id', b.accountId)
  ok('RLS blocks foreign CRM/business sheet by account ID', !foreignCrm.error && (foreignCrm.data ?? []).length === 0)

  const connectSecret = await fetch(`${url}/functions/v1/connect-provider`, { method: 'POST', headers: { Authorization: `Bearer ${b.jwt}`, apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'connect', provider: 'sentry', api_key: 'test-secret-never-selectable' }) })
  const connectPayload = await connectSecret.json()
  const { data: encryptedProvider } = await admin.from('provider_keys').select('api_key').eq('account_id', b.accountId).eq('provider', 'sentry').single()
  ok('New provider credential is AES-GCM encrypted at rest', connectPayload?.ok === true && encryptedProvider?.api_key?.startsWith('enc:v1:'))
  const providerRead = await a.client.from('provider_keys').select('api_key').eq('account_id', b.accountId)
  ok('Browser role cannot select provider secrets', Boolean(providerRead.error) || (providerRead.data ?? []).length === 0)

  const { data: dialogueB } = await admin.from('dialogues').insert({ agent_id: agentB.id, channel: 'widget', external_id: `sec-${stamp}` }).select('id').single()
  const takeover = await fetch(`${url}/functions/v1/operator-send`, { method: 'POST', headers: { Authorization: `Bearer ${a.jwt}`, apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ dialogue_id: dialogueB.id, text: 'forged takeover' }) })
  ok('Foreign operator takeover is denied', takeover.status === 404 || takeover.status === 403, `HTTP ${takeover.status}`)

  const nonAdmin = await fetch(`${url}/functions/v1/admin-api`, { method: 'POST', headers: { Authorization: `Bearer ${a.jwt}`, apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list_accounts' }) })
  ok('Non-admin direct admin API is denied', nonAdmin.status === 403, `HTTP ${nonAdmin.status}`)
  const tampered = await fetch(`${url}/functions/v1/backend-status`, { method: 'POST', headers: { Authorization: `Bearer ${a.jwt.slice(0, -4)}xxxx`, apikey: anonKey, 'Content-Type': 'application/json' }, body: '{}' })
  ok('Tampered JWT is denied', tampered.status === 401 || tampered.status === 403, `HTTP ${tampered.status}`)
  const cors = await fetch(`${url}/functions/v1/admin-api`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } })
  ok('Foreign browser origin is denied', cors.status === 403 && cors.headers.get('access-control-allow-origin') !== '*', `HTTP ${cors.status}`)

  await admin.from('accounts').update({ token_balance: 0 }).eq('id', b.accountId)
  const reservations = await Promise.all([
    admin.rpc('reserve_logistics_credits', { p_account: b.accountId, p_credits: 1 }),
    admin.rpc('reserve_logistics_credits', { p_account: b.accountId, p_credits: 1 }),
  ])
  const { data: zeroAcc } = await admin.from('accounts').select('token_balance').eq('id', b.accountId).single()
  ok('Concurrent zero-balance reservations cannot overspend', reservations.every((r) => r.data === false) && Number(zeroAcc?.token_balance) === 0)

  const oversized = await b.client.from('knowledge_docs').insert({ owner_type: 'agent', owner_id: agentB.id, source: 'file', name: 'oversized.txt', content: 'x'.repeat(200001) })
  ok('Oversized RAG payload is rejected by database', Boolean(oversized.error))

  let created = 0
  let rateBlocked = false
  for (let i = 0; i < 35; i++) {
    const r = await b.client.from('agents').insert({ name: `rate-${stamp}-${i}` })
    if (r.error) { rateBlocked = /rate limit/i.test(r.error.message); break }
    created++
  }
  ok('Agent creation burst is rate-limited', rateBlocked && created <= 30, `${created} accepted before block`)

  // Leads concurrency (security gate #29): truly parallel PostgREST calls — merges must not
  // lose fields or duplicate rows, and the CRM-push claim must have exactly one winner.
  const claimTokenOf = (r) => (Array.isArray(r.data) ? r.data[0] : r.data)?.claim_token ?? null
  const { data: leadDialogue } = await admin.from('dialogues').insert({ agent_id: agentB.id, channel: 'widget', external_id: `lead-${stamp}` }).select('id').single()
  const merges = await Promise.all([
    admin.rpc('merge_lead_fields', { p_account_id: b.accountId, p_dialogue_id: leadDialogue.id, p_patch: { name: 'Aziz' } }),
    admin.rpc('merge_lead_fields', { p_account_id: b.accountId, p_dialogue_id: leadDialogue.id, p_patch: { phone: '+998901234567' } }),
  ])
  const { data: leadRows } = await admin.from('leads').select('id, fields').eq('dialogue_id', leadDialogue.id)
  ok('Parallel lead merges keep one row with both fields', merges.every((r) => !r.error) && (leadRows ?? []).length === 1 && leadRows?.[0]?.fields?.name === 'Aziz' && leadRows?.[0]?.fields?.phone === '+998901234567')
  const leadId = leadRows?.[0]?.id
  const foreignClaim = await admin.rpc('claim_lead_crm_push', { p_account_id: a.accountId, p_lead_id: leadId })
  ok('Cross-account CRM-push claim is refused', !foreignClaim.error && claimTokenOf(foreignClaim) === null)
  const claims = await Promise.all([
    admin.rpc('claim_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId }),
    admin.rpc('claim_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId }),
  ])
  const winnerTokens = claims.map(claimTokenOf).filter(Boolean)
  ok('Concurrent CRM-push claims have exactly one winner', claims.every((r) => !r.error) && winnerTokens.length === 1)
  const release = await admin.rpc('finish_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId, p_token: winnerTokens[0], p_provider: null })
  const reclaimAfterRelease = await admin.rpc('claim_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId })
  ok('Released claim (nothing was sent) is immediately reclaimable', release.data === true && Boolean(claimTokenOf(reclaimAfterRelease)))
  const staleSet = await admin.from('leads').update({ crm_push_claimed_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }).eq('id', leadId)
  const reclaim = await admin.rpc('claim_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId })
  const reclaimToken = claimTokenOf(reclaim)
  ok('Stale CRM-push claim is reclaimable', !staleSet.error && !reclaim.error && Boolean(reclaimToken))
  const wrongToken = await admin.rpc('finish_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId, p_token: crypto.randomUUID(), p_provider: 'forged' })
  const foreignFinish = await admin.rpc('finish_lead_crm_push', { p_account_id: a.accountId, p_lead_id: leadId, p_token: reclaimToken, p_provider: 'forged' })
  const finish = await admin.rpc('finish_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId, p_token: reclaimToken, p_provider: 'bitrix24' })
  const afterFinish = await admin.rpc('claim_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId })
  ok('Only the tenant token holder finishes; completed lead is not reclaimable', wrongToken.data === false && foreignFinish.data === false && finish.data === true && !afterFinish.error && claimTokenOf(afterFinish) === null)
  const foreignMerge = await admin.rpc('merge_lead_fields', { p_account_id: a.accountId, p_dialogue_id: leadDialogue.id, p_patch: { name: 'intruder' } })
  ok('Cross-account lead merge is rejected', Boolean(foreignMerge.error))
  const browserMerge = await b.client.rpc('merge_lead_fields', { p_account_id: b.accountId, p_dialogue_id: leadDialogue.id, p_patch: { name: 'browser' } })
  const browserClaim = await b.client.rpc('claim_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId })
  const browserFinish = await b.client.rpc('finish_lead_crm_push', { p_account_id: b.accountId, p_lead_id: leadId, p_token: crypto.randomUUID(), p_provider: 'forged' })
  const browserWrite = await b.client.from('leads').update({ pushed_to_crm: false }).eq('id', leadId)
  ok('Browser role cannot execute lead RPCs or write leads directly', Boolean(browserMerge.error) && Boolean(browserClaim.error) && Boolean(browserFinish.error) && Boolean(browserWrite.error))

  // Team-shared RAG: tenant-scoped team docs, account-aware retrieval, cross-tenant guards.
  const { data: deptB, error: deptErr } = await admin.from('departments').insert({ account_id: b.accountId, main_agent_id: agentB.id, name: `RAG team ${stamp}` }).select('id').single()
  ok('Same-tenant department creation works with the tenant guard on', !deptErr && Boolean(deptB?.id))
  const crossDept = await admin.from('departments').insert({ account_id: a.accountId, main_agent_id: agentB.id, name: 'forged cross-tenant team' })
  ok('Cross-tenant department lead is rejected by the database', Boolean(crossDept.error))
  const { data: teamDoc, error: teamDocErr } = await b.client.from('knowledge_docs').insert({ owner_type: 'team', owner_id: deptB.id, source: 'faq', name: 'team-shared', content: `TEAM_SHARED_FACT_${stamp}: office opens at 9am` }).select('id').single()
  ok('Owner tenant can create a team knowledge doc', !teamDocErr && Boolean(teamDoc?.id))
  const foreignTeamDoc = await a.client.from('knowledge_docs').insert({ owner_type: 'team', owner_id: deptB.id, source: 'faq', name: 'intruder', content: 'foreign write' })
  ok('Foreign tenant cannot write into another team\'s knowledge', Boolean(foreignTeamDoc.error))
  const foreignTeamRead = await a.client.from('knowledge_docs').select('id').eq('owner_type', 'team').eq('owner_id', deptB.id)
  ok('Foreign tenant cannot read another team\'s knowledge', !foreignTeamRead.error && (foreignTeamRead.data ?? []).length === 0)
  const indexTeamDoc = await fetch(`${url}/functions/v1/knowledge-index`, { method: 'POST', headers: { Authorization: `Bearer ${b.jwt}`, apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'index', doc_id: teamDoc.id }) })
  const indexPayload = await indexTeamDoc.json().catch(() => ({}))
  ok('Team doc indexes into chunks for the owner tenant', indexTeamDoc.status === 200 && indexPayload?.ok === true && Number(indexPayload?.chunks) >= 1)
  const foreignIndex = await fetch(`${url}/functions/v1/knowledge-index`, { method: 'POST', headers: { Authorization: `Bearer ${a.jwt}`, apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'index', doc_id: teamDoc.id }) })
  ok('Foreign tenant cannot index another team\'s doc', foreignIndex.status === 403)
  const unitVec = [1, ...Array(383).fill(0)]
  const ragOwn = await admin.rpc('match_knowledge_team', { p_account_id: b.accountId, p_agent_id: null, p_department_id: deptB.id, p_query: unitVec, p_k: 5 })
  ok('Account-verified team retrieval returns the shared chunks', !ragOwn.error && Array.isArray(ragOwn.data) && ragOwn.data.length >= 1)
  const ragForeign = await admin.rpc('match_knowledge_team', { p_account_id: a.accountId, p_agent_id: null, p_department_id: deptB.id, p_query: unitVec, p_k: 5 })
  ok('Mismatched account + department yields nothing (fail closed)', !ragForeign.error && (ragForeign.data ?? []).length === 0)
  const browserRag = await b.client.rpc('match_knowledge_team', { p_account_id: b.accountId, p_agent_id: null, p_department_id: deptB.id, p_query: unitVec, p_k: 5 })
  ok('Browser role cannot execute team retrieval directly', Boolean(browserRag.error))

  await admin.from('google_accounts').upsert({ account_id: a.accountId, google_email: 'security@example.invalid', refresh_token: 'temporary-refresh-token' })
  await admin.from('google_oauth_apps').upsert({ account_id: a.accountId, client_id: 'temporary-client', client_secret: 'temporary-secret' })
  await admin.from('provider_keys').upsert({ account_id: a.accountId, provider: 'sentry', api_key: 'temporary-provider-secret' })
  const deletedAccount = a.accountId
  await admin.from('accounts').delete().eq('id', deletedAccount)
  const [pk, ga, go] = await Promise.all([
    admin.from('provider_keys').select('account_id').eq('account_id', deletedAccount),
    admin.from('google_accounts').select('account_id').eq('account_id', deletedAccount),
    admin.from('google_oauth_apps').select('account_id').eq('account_id', deletedAccount),
  ])
  ok('Deleting account cascades provider/OAuth secrets', [pk, ga, go].every((r) => !r.error && (r.data ?? []).length === 0))
  accounts.splice(accounts.indexOf(deletedAccount), 1)
} finally {
  for (const accountId of accounts) await admin.from('accounts').delete().eq('id', accountId)
  for (const userId of users) await admin.auth.admin.deleteUser(userId)
  fs.writeFileSync(path.join(root, 'agent-hub/security-live-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), failed, report }, null, 2))
}
if (failed) process.exit(1)
console.log('All isolated live security smokes passed; temporary data removed.')
