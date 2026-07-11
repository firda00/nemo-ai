// Post-deploy authenticated smoke for Logistics Control. Creates an isolated
// temporary tenant, runs risk + recovery snapshots, verifies persistence, and
// removes the tenant. It never connects a channel or sends an external message.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const secrets = Object.fromEntries(readFileSync(new URL('../.secrets.local', import.meta.url), 'utf8').split(/\r?\n/).map((line) => {
  const at = line.indexOf('=')
  return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : ['', '']
}).filter(([key]) => key))

const ref = secrets.SUPABASE_PROJECT_REF
const secretKey = secrets.SUPABASE_SECRET_KEY
const publishableKey = secrets.SUPABASE_PUBLISHABLE_KEY
if (!ref || !secretKey || !publishableKey) throw new Error('Supabase smoke credentials are not configured.')

const url = `https://${ref}.supabase.co`
const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `nemo-logistics-smoke-${Date.now()}@example.com`
const password = `${randomUUID()}Aa1!`
let userId = ''
let accountId = ''

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tashkentDate = (offsetDays = 0) => new Date(Date.now() + 5 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10)

try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name: 'Logistics Smoke' } })
  if (created.error || !created.data.user) throw new Error(`temporary user creation failed: ${created.error?.message ?? 'missing user'}`)
  userId = created.data.user.id

  for (let i = 0; i < 20 && !accountId; i++) {
    const { data } = await admin.from('users').select('account_id').eq('id', userId).maybeSingle()
    accountId = data?.account_id ?? ''
    if (!accountId) await delay(250)
  }
  if (!accountId) throw new Error('temporary account trigger did not finish')

  const client = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const signed = await client.auth.signInWithPassword({ email, password })
  if (signed.error || !signed.data.session) throw new Error(`temporary sign-in failed: ${signed.error?.message ?? 'missing session'}`)

  const { data: agent, error: agentError } = await client.from('agents').insert({ account_id: accountId, name: 'Logistics Smoke Team', prompt: { role: 'Team lead', tasks: 'Smoke test logistics', rules: 'No external actions.' } }).select('id').single()
  if (agentError || !agent) throw new Error(`agent setup failed: ${agentError?.message ?? 'missing row'}`)
  const { data: department, error: departmentError } = await client.from('departments').insert({ account_id: accountId, main_agent_id: agent.id, name: 'Logistics Smoke', niche: 'logistics' }).select('id').single()
  if (departmentError || !department) throw new Error(`department setup failed: ${departmentError?.message ?? 'missing row'}`)
  const { error: subsError } = await client.from('sub_agents').insert([
    { account_id: accountId, department_id: department.id, role: 'Exception Triage Agent', name: 'Exception Controller', prompt: { role: 'Triage verified exceptions', rules: 'Draft only.' }, status: 'active' },
    { account_id: accountId, department_id: department.id, role: 'Logistics Report Agent', name: 'Logistics Reporter', prompt: { role: 'Report verified facts', rules: 'No invented facts.' }, status: 'active' },
  ])
  if (subsError) throw new Error(`specialist setup failed: ${subsError.message}`)

  const orderId = `SMOKE-${Date.now()}`
  const riskInput = `order_id,customer,carrier,status,shipped_at,promised_date,last_event_at,owner\n${orderId},Smoke customer,Smoke carrier,shipped,${tashkentDate(-4)},${tashkentDate(-1)},${tashkentDate(-3)} 09:00,Smoke owner`
  const first = await client.functions.invoke('logistics-workflow', { body: { action: 'logistics_control', department_id: department.id, source: 'manual', lang: 'en', input: riskInput } })
  if (first.error || !first.data?.ok) throw new Error(`risk run failed: ${first.data?.message ?? first.error?.message ?? 'unknown error'}`)
  if (first.data.capabilities?.external_messages_sent !== false) throw new Error('external action safety flag is incorrect')
  if (!first.data.tasks?.length || first.data.tasks[0]?.owner !== 'Smoke owner') throw new Error('deterministic owner task was not persisted')

  const { data: openTasks, error: openError } = await client.from('tasks').select('id, status, subject_key').eq('department_id', department.id).eq('source', 'logistics').neq('status', 'done')
  if (openError || openTasks?.length !== 1 || !openTasks[0].subject_key) throw new Error('open logistics task verification failed')

  const recoveryInput = `order_id,customer,carrier,status,shipped_at,promised_date,last_event_at,owner\n${orderId},Smoke customer,Smoke carrier,delivered,${tashkentDate(-4)},${tashkentDate(-1)},${tashkentDate()} 09:00,Smoke owner`
  const second = await client.functions.invoke('logistics-workflow', { body: { action: 'logistics_control', department_id: department.id, source: 'manual', lang: 'en', input: recoveryInput } })
  if (second.error || !second.data?.ok) throw new Error(`recovery run failed: ${second.data?.message ?? second.error?.message ?? 'unknown error'}`)
  if (!second.data.recovered_task_ids?.includes(openTasks[0].id)) throw new Error('recovery rule did not report the closed task')
  const { data: closedTask } = await client.from('tasks').select('status, completed_by').eq('id', openTasks[0].id).single()
  if (closedTask?.status !== 'done' || !/Logistics recovery rule/.test(closedTask?.completed_by ?? '')) throw new Error('recovery task audit was not persisted')

  console.log('Authenticated logistics live smoke passed: risk task, safety flags, persistence, and recovery verified.')
} finally {
  if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {})
  if (accountId) await admin.from('accounts').delete().eq('id', accountId)
}
