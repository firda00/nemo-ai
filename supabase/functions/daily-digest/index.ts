// Autonomous founder-pulse agent — "an agent reports the business every morning".
// Called by pg_cron once a day with x-cron-secret. For every account that set an owner
// Telegram (business_profiles.notify_chat_id) and had activity yesterday, sends a short
// digest (dialogues / new leads / tokens) to that account's own Telegram bot. Works
// per-account, no global admin config needed. Silent for accounts with no activity.
//   POST /functions/v1/daily-digest   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const secret = req.headers.get('x-cron-secret')
  const auth = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) {
    return new Response('forbidden', { status: 403 })
  }
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: rows, error } = await db.rpc('ops_daily_digest')
  if (error) return json({ ok: false, error: error.message }, 500)
  const accounts = (rows ?? []) as Any[]
  // only accounts that actually had activity yesterday (don't ping idle owners)
  const active = accounts.filter((r) => Number(r.dialogues) + Number(r.leads) + Number(r.tokens) > 0)
  if (active.length === 0) return json({ ok: true, candidates: accounts.length, sent: 0 })

  // one Telegram bot token per account (from its agents' telegram channels)
  const accIds = active.map((r) => r.account_id)
  const { data: agents } = await db.from('agents').select('id, account_id').in('account_id', accIds)
  const agentsByAcc: Record<string, string[]> = {}
  for (const a of (agents ?? []) as Any[]) (agentsByAcc[a.account_id] ??= []).push(a.id)

  let sent = 0
  for (const r of active) {
    try {
      const agentIds = agentsByAcc[r.account_id] ?? []
      if (!agentIds.length) continue
      const { data: ch } = await db.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', agentIds).limit(1).maybeSingle()
      const token = ch?.credentials?.bot_token
      if (!token) continue
      const tokens = Number(r.tokens).toLocaleString('ru-RU')
      const msg = `📊 Nemo — kunlik hisobot (kecha):\n• Dialoglar: ${r.dialogues}\n• Yangi lidlar: ${r.leads}\n• Sarflangan tokenlar: ${tokens}\n\nBatafsil — Nemo'dagi «Monitoring» va «Faollik» bo'limlarida.`
      if (await tgSend(String(token), String(r.notify_chat_id), msg)) sent++
    } catch { /* best effort per account */ }
  }

  return json({ ok: true, candidates: accounts.length, active: active.length, sent })
})
