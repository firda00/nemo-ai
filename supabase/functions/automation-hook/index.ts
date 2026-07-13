// Public incoming-webhook trigger for automations (the Zapier "trigger" side). An external
// service POSTs to /automation-hook/<secret>; we find the automation by its unguessable secret
// and run its steps with the request body as {{input}}. PUBLIC (the secret is the auth).
//   POST /functions/v1/automation-hook/<secret>   body: any (becomes {{input}})
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { runAutomation } from '../_shared/automationEngine.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const secret = new URL(req.url).pathname.split('/').filter(Boolean).pop()
  if (!secret || secret === 'automation-hook') return new Response('no secret', { status: 400 })

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const { data: a } = await db.from('automations').select('*').eq('webhook_secret', secret).eq('enabled', true).maybeSingle()
  if (!a) return new Response('not found', { status: 404 })

  const inputRaw = await req.text().catch(() => '')
  const apiKey = await resolveOpenRouterKey(db, a.account_id, OPENROUTER_API_KEY)
  // resolve owner Telegram (for notify steps) + a bot token
  const { data: bp } = await db.from('business_profiles').select('notify_chat_id').eq('account_id', a.account_id).maybeSingle()
  const { data: ags } = await db.from('agents').select('id').eq('account_id', a.account_id)
  const agentIds = ((ags ?? []) as Any[]).map((x) => x.id)
  let tgToken: string | undefined
  if (agentIds.length) { const { data: ch } = await db.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', agentIds).limit(1).maybeSingle(); tgToken = ch?.credentials?.bot_token }

  const log = await runAutomation(db, a.account_id, apiKey, a.steps ?? [], String(inputRaw).slice(0, 4000), tgToken, bp?.notify_chat_id)
  await db.from('automations').update({ last_run_at: new Date().toISOString(), last_result: log }).eq('id', a.id)
  return json({ ok: true, ran: log.length })
})
