// Weekly team report agent — "the platform reports the week by itself". Called by pg_cron
// (Monday morning) with x-cron-secret. For every account with an owner Telegram, sends a
// one-message weekly task summary (created / open / overdue) to that account's Telegram bot.
// Per-account (business_profiles.notify_chat_id) — no global admin config; silent if idle.
//   POST /functions/v1/weekly-report   (header: x-cron-secret: <CRON_SECRET>)
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

  const { data: rows, error } = await db.rpc('ops_weekly_report')
  if (error) return json({ ok: false, error: error.message }, 500)
  // only accounts with any task activity (don't ping owners with an empty board)
  const active = ((rows ?? []) as Any[]).filter((r) => Number(r.created) + Number(r.open_cnt) > 0)
  if (active.length === 0) return json({ ok: true, candidates: (rows ?? []).length, sent: 0 })

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
      const warn = Number(r.overdue) > 0 ? `\n⚠️ Muddati o'tgan: ${r.overdue} — e'tibor bering.` : ''
      const msg = `🗓 Nemo — haftalik hisobot:\n• Yangi vazifalar: ${r.created}\n• Ochiq: ${r.open_cnt}\n• Muddati o'tgan: ${r.overdue}${warn}\n\nBatafsil — Nemo'dagi «Vazifalar» va «Monitoring» bo'limlarida.`
      if (await tgSend(String(token), String(r.notify_chat_id), msg)) sent++
    } catch { /* best effort per account */ }
  }

  return json({ ok: true, candidates: (rows ?? []).length, active: active.length, sent })
})
