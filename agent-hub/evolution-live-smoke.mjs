import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (match) => match.slice(1))), '..')
const secrets = Object.fromEntries(fs.readFileSync(path.join(root, '.secrets.local'), 'utf8').split(/\r?\n/).map((line) => {
  const at = line.indexOf('=')
  return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['', '']
}).filter(([key]) => key))

const ref = secrets.SUPABASE_PROJECT_REF
const secretKey = secrets.SUPABASE_SECRET_KEY
const publishableKey = secrets.SUPABASE_PUBLISHABLE_KEY
if (!ref || !secretKey || !publishableKey) throw new Error('Supabase smoke credentials are not configured.')

const url = `https://${ref}.supabase.co`
const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `nemo-evolution-smoke-${Date.now()}@example.com`
const password = `${randomUUID()}Aa1!`
let userId = ''

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Evolution Smoke' } })
  if (created.error || !created.data.user) throw new Error(`temporary user failed: ${created.error?.message ?? 'missing user'}`)
  userId = created.data.user.id
  let accountId = ''
  for (let i = 0; i < 24 && !accountId; i += 1) {
    const { data } = await admin.from('users').select('account_id').eq('id', userId).maybeSingle()
    accountId = data?.account_id ?? ''
    if (!accountId) await delay(250)
  }
  if (!accountId) throw new Error('temporary account trigger did not finish')
  const signed = await client.auth.signInWithPassword({ email, password })
  if (signed.error) throw new Error(`temporary sign-in failed: ${signed.error.message}`)

  const before = { role: 'Support agent', tasks: 'Answer known questions', tone: 'Clear', rules: 'Escalate uncertainty' }
  const after = { ...before, tone: 'Warm and clear' }
  const inserted = await client.from('agents').insert({ account_id: accountId, name: 'Evolution smoke agent', type: 'support', status: 'active', prompt: after })
    .select('id').single()
  if (inserted.error || !inserted.data) throw new Error(`agent setup failed: ${inserted.error?.message ?? 'missing row'}`)
  const agentId = inserted.data.id

  const settings = await client.functions.invoke('evolve-agent', { body: { action: 'settings', agent_id: agentId, auto_evolve: true, direction: 'Improve clarity' } })
  if (settings.error || !settings.data?.ok || !settings.data?.auto_evolve) throw new Error('owner could not enable governed evolution')
  const saved = await client.from('agents').select('auto_evolve, growth_direction').eq('id', agentId).single()
  if (saved.error || !saved.data.auto_evolve || saved.data.growth_direction !== 'Improve clarity') throw new Error('evolution settings did not persist')

  const evolution = await admin.from('agent_evolutions').insert({
    account_id: accountId, agent_id: agentId, prompt_before: before, prompt_after: after,
    summary: 'smoke change', applied: true, auto_applied: true, review_score: 95, applied_at: new Date().toISOString(),
  }).select('id').single()
  if (evolution.error || !evolution.data) throw new Error(`evolution setup failed: ${evolution.error?.message ?? 'missing row'}`)
  const rollback = await client.functions.invoke('evolve-agent', { body: { action: 'rollback', agent_id: agentId, evolution_id: evolution.data.id } })
  if (rollback.error || !rollback.data?.rolled_back || !String(rollback.data?.prompt?.rules).includes('LOCKED NEMO SAFETY')) throw new Error('rollback did not restore and lock the previous prompt')
  const restored = await client.from('agents').select('prompt').eq('id', agentId).single()
  if (restored.error || restored.data.prompt.tone !== before.tone) throw new Error('previous prompt was not restored')

  await client.functions.invoke('evolve-agent', { body: { action: 'settings', agent_id: agentId, auto_evolve: false, direction: 'Improve clarity' } })
  const unauthorized = await fetch(`${url}/functions/v1/evolve-agent`, {
    method: 'POST', headers: { apikey: publishableKey, 'Content-Type': 'application/json', 'x-cron-secret': 'wrong-secret' },
    body: JSON.stringify({ action: 'auto-run' }),
  })
  if (unauthorized.status !== 401) throw new Error(`invalid cron secret was not rejected (${unauthorized.status})`)
  console.log('Governed evolution live smoke passed: opt-in settings, tenant persistence, safe rollback and cron authentication verified.')
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId)
}
