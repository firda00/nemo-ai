// Autonomous support SLA agent — "an agent watches support so no customer is forgotten".
// Called by pg_cron (~every 10 min) with x-cron-secret. Finds dialogues that were escalated
// to a human (status=needs_operator, no operator takeover) and have been WAITING past the SLA
// (15 min), and pings each account's operator once (a 10-min window keeps it from re-spamming).
// Reuses the per-account operator channel (business_profiles.notify_chat_id + the account's
// Telegram bot), so it works without any global admin config.
//   POST /functions/v1/support-sla   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const SLA_MIN = 15   // waiting longer than this = breach
const WINDOW_MIN = 12 // only newly-crossed breaches (matches the ~10-min cron cadence, + jitter)

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

  const cutHi = new Date(Date.now() - SLA_MIN * 60_000).toISOString()
  const cutLo = new Date(Date.now() - (SLA_MIN + WINDOW_MIN) * 60_000).toISOString()

  // dialogues that just crossed the SLA and still have no human on them
  const { data: dlgs } = await db.from('dialogues')
    .select('id, agent_id, customer_name, updated_at')
    .eq('status', 'needs_operator').eq('operator_takeover', false)
    .lt('updated_at', cutHi).gt('updated_at', cutLo).limit(200)

  if (!dlgs || dlgs.length === 0) return json({ ok: true, breaches: 0, notified: 0 })

  // map agent -> account + name
  const agentIds = [...new Set(dlgs.map((d: Any) => d.agent_id).filter(Boolean))]
  const { data: agents } = await db.from('agents').select('id, account_id, name').in('id', agentIds)
  const agentMap: Record<string, { account_id: string; name: string }> = {}
  for (const a of (agents ?? []) as Any[]) agentMap[a.id] = { account_id: a.account_id, name: a.name }

  // group waiting dialogues by account
  const byAccount: Record<string, { name: string; agent: string }[]> = {}
  for (const d of dlgs as Any[]) {
    const acc = agentMap[d.agent_id]?.account_id
    if (!acc) continue
    ;(byAccount[acc] ??= []).push({ name: d.customer_name || 'mijoz', agent: agentMap[d.agent_id]?.name || 'AI' })
  }

  let notified = 0
  for (const [accountId, waiting] of Object.entries(byAccount)) {
    try {
      const { data: bp } = await db.from('business_profiles').select('notify_chat_id').eq('account_id', accountId).maybeSingle()
      const target = bp?.notify_chat_id
      if (!target) continue
      // any Telegram bot token on this account's agents
      const accAgentIds = Object.entries(agentMap).filter(([, v]) => v.account_id === accountId).map(([id]) => id)
      const { data: ch } = await db.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', accAgentIds).limit(1).maybeSingle()
      const token = ch?.credentials?.bot_token
      if (!token) continue
      const list = waiting.slice(0, 8).map((w) => `• ${w.name} (${w.agent})`).join('\n')
      const more = waiting.length > 8 ? `\n… +${waiting.length - 8}` : ''
      const msg = `⏰ Operator kutilmoqda: ${waiting.length} ta mijoz ${SLA_MIN}+ daqiqadan beri javob kutmoqda:\n${list}${more}\n\nNemo'da «Dialoglar»ni oching va javob bering.`
      if (await tgSend(String(token), String(target), msg)) notified++
    } catch { /* best effort per account */ }
  }

  return json({ ok: true, breaches: dlgs.length, accounts: Object.keys(byAccount).length, notified })
})
