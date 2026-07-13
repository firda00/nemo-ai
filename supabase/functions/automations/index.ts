// AI-native automation engine (the Zapier/Make/n8n layer). The owner DESCRIBES an automation in
// words; an LLM builds the steps; and this runs them in order, threading data between steps.
// Step types: agent (an AI does a task), http (call any API, SSRF-guarded), notify (Telegram).
//   POST /functions/v1/automations   (Authorization: Bearer <user jwt>)
//   { action: 'generate'|'list'|'get'|'run'|'delete'|'toggle', ... }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { callOpenRouter, PRIMARY_MODEL, FALLBACK_MODEL } from '../_shared/llm.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { runAutomation } from '../_shared/automationEngine.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

function extractJson(text: string): Any { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s === -1 || e === -1) return null; try { return JSON.parse(text.slice(s, e + 1)) } catch { return null } }

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: prof } = await userDb.from('users').select('account_id').maybeSingle()
  const accountId = prof?.account_id
  if (!accountId) return json({ error: 'no account' }, 403)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE)
  const body = await req.json().catch(() => ({}))
  const action = String(body?.action ?? '')

  if (action === 'list') {
    const { data } = await admin.from('automations').select('id, name, description, trigger, enabled, last_run_at, steps, webhook_secret, created_at').eq('account_id', accountId).order('created_at', { ascending: false }).limit(50)
    // expose the webhook URL (not the bare secret) so the client can copy it
    const automations = ((data ?? []) as Any[]).map((a) => ({ ...a, webhook_url: a.webhook_secret ? `${SUPABASE_URL}/functions/v1/automation-hook/${a.webhook_secret}` : null, webhook_secret: undefined }))
    return json({ ok: true, automations })
  }
  if (action === 'webhook') {
    // enable an incoming webhook trigger: external apps POST to this URL to run the automation
    const id = String(body?.id ?? '')
    const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    await admin.from('automations').update({ trigger: 'webhook', webhook_secret: secret, enabled: true }).eq('id', id).eq('account_id', accountId)
    return json({ ok: true, url: `${SUPABASE_URL}/functions/v1/automation-hook/${secret}` })
  }
  if (action === 'delete') { await admin.from('automations').delete().eq('id', String(body?.id)).eq('account_id', accountId); return json({ ok: true }) }
  if (action === 'toggle') { await admin.from('automations').update({ enabled: Boolean(body?.enabled) }).eq('id', String(body?.id)).eq('account_id', accountId); return json({ ok: true }) }

  if (action === 'generate') {
    const description = String(body?.description ?? '').trim()
    if (description.length < 8) return json({ ok: false, error: 'Опишите автоматизацию подробнее.' }, 200)
    const apiKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
    const sys = 'You build an automation (Zapier/n8n style) from a plain description. Respond ONLY as JSON: ' +
      '{"name": string, "steps": [ ... ]}. Step types: ' +
      '{"type":"agent","name":"short_id","instruction":"what the AI should do; reference data with {{input}} and {{previousStepName}}"} ; ' +
      '{"type":"http","name":"short_id","method":"GET|POST","url":"https://... (use {{...}} for values)","headers":{},"body":""} ; ' +
      '{"type":"notify","name":"short_id","text":"Telegram message to the owner, can use {{stepName}}"} . ' +
      'Use 1-5 steps, snake_case step names, and reference earlier outputs with {{name}}. Keep it practical.'
    const r = await callOpenRouter({ apiKey, model: PRIMARY_MODEL, fallbackModel: FALLBACK_MODEL, temperature: 0.3, maxTokens: 900, messages: [{ role: 'system', content: sys }, { role: 'user', content: description }] })
    const j = extractJson(r.content)
    if (!j || !Array.isArray(j.steps) || !j.steps.length) return json({ ok: false, error: 'Не удалось собрать автоматизацию — переформулируйте.' }, 200)
    const { data: row, error } = await admin.from('automations').insert({ account_id: accountId, name: String(j.name || 'Automation').slice(0, 80), description, steps: j.steps.slice(0, 8) }).select('id, name, description, steps').single()
    if (error) return json({ ok: false, error: error.message }, 200)
    return json({ ok: true, automation: row })
  }

  if (action === 'run') {
    const { data: a } = await admin.from('automations').select('*').eq('id', String(body?.id)).eq('account_id', accountId).maybeSingle()
    if (!a) return json({ ok: false, error: 'not found' }, 404)
    const apiKey = await resolveOpenRouterKey(admin, accountId, OPENROUTER_API_KEY)
    // owner Telegram (for notify steps)
    const { data: bp } = await admin.from('business_profiles').select('notify_chat_id').eq('account_id', accountId).maybeSingle()
    const { data: ags } = await admin.from('agents').select('id').eq('account_id', accountId)
    const agentIds = ((ags ?? []) as Any[]).map((x) => x.id)
    let tgToken: string | undefined
    if (agentIds.length) { const { data: ch } = await admin.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', agentIds).limit(1).maybeSingle(); tgToken = ch?.credentials?.bot_token }
    const log = await runAutomation(admin, accountId, apiKey, a.steps ?? [], String(body?.input ?? ''), tgToken, bp?.notify_chat_id)
    await admin.from('automations').update({ last_run_at: new Date().toISOString(), last_result: log }).eq('id', a.id)
    return json({ ok: true, log })
  }

  return json({ error: 'unknown action' }, 400)
})
