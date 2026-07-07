// Autonomous ops watchdog — "an agent keeps the site up and watches support".
// Called by pg_cron (~every 10 min) with x-cron-secret. Checks the site, the VPS worker,
// the database and the support queue, writes one ops_checks row, and — only when the overall
// status CHANGES — sends a Telegram alert to the admin (so no spam every tick). Recovery is
// announced too. Configure OPS_ALERT_BOT_TOKEN + OPS_ALERT_CHAT_ID to receive alerts.
//   POST /functions/v1/ops-watchdog   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://nemo.185.8.213.144.sslip.io').replace(/\/$/, '')
const RENDER_WORKER_URL = (Deno.env.get('RENDER_WORKER_URL') ?? '').replace(/\/$/, '')
const RENDER_SECRET = Deno.env.get('RENDER_SECRET') ?? ''
const ALERT_BOT = Deno.env.get('OPS_ALERT_BOT_TOKEN') ?? ''
const ALERT_CHAT = Deno.env.get('OPS_ALERT_CHAT_ID') ?? ''

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Check = { ok: boolean; info: string }
async function timed(fn: () => Promise<Check>, timeoutMs = 8000): Promise<Check> {
  try {
    return await Promise.race([fn(), new Promise<Check>((_, r) => setTimeout(() => r(new Error('timeout')), timeoutMs))])
  } catch (e) { return { ok: false, info: String((e as Error)?.message ?? e).slice(0, 120) } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const secret = req.headers.get('x-cron-secret')
  const auth = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) {
    return new Response('forbidden', { status: 403 })
  }
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details: Record<string, Check> = {}

  // 1) database
  details.database = await timed(async () => {
    const { error } = await db.from('accounts').select('id', { count: 'exact', head: true })
    return error ? { ok: false, info: error.message.slice(0, 120) } : { ok: true, info: 'reachable' }
  })

  // 2) public site
  details.site = await timed(async () => {
    const r = await fetch(SITE_URL, { method: 'GET' })
    return { ok: r.status < 400, info: `HTTP ${r.status}` }
  })

  // 3) VPS worker (video + code sandbox)
  details.worker = RENDER_WORKER_URL
    ? await timed(async () => {
        const r = await fetch(`${RENDER_WORKER_URL}/health`, { headers: { 'x-render-secret': RENDER_SECRET } })
        return { ok: r.ok, info: `HTTP ${r.status}` }
      })
    : { ok: true, info: 'not configured' }

  // 4) support queue — customers waiting for a human
  details.support = await timed(async () => {
    const { count: waiting } = await db.from('dialogues').select('id', { count: 'exact', head: true }).eq('status', 'needs_operator')
    const { count: errored } = await db.from('dialogues').select('id', { count: 'exact', head: true }).eq('status', 'error')
    const w = waiting ?? 0, e = errored ?? 0
    return { ok: w === 0 && e === 0, info: `${w} kutmoqda / ${e} xato` }
  })

  // 5) cost guard — today's token burn + the single top-spending account (anomaly = runaway)
  details.cost = await timed(async () => {
    const { data, error } = await db.rpc('ops_usage_today')
    if (error) return { ok: false, info: `rpc error: ${error.message.slice(0, 80)}` }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row: any = Array.isArray(data) ? data[0] : data
    const total = Number(row?.total ?? 0), top = Number(row?.top_tokens ?? 0)
    const spike = top > 3_000_000 // one account burning >3M tokens/day = investigate
    return { ok: !spike, info: `${total.toLocaleString('ru-RU')} tok bugun · top hisob ${top.toLocaleString('ru-RU')}` }
  })

  // overall status: down if site/DB down; warn if worker/support/cost need attention
  const hard = details.database.ok && details.site.ok
  const status = !hard ? 'down' : (details.worker.ok && details.support.ok && details.cost.ok) ? 'ok' : 'warn'
  const failing = Object.entries(details).filter(([, c]) => !c.ok).map(([k]) => k)
  const summary = status === 'ok' ? 'Hammasi ishlayapti' : `Muammo: ${failing.join(', ')}`

  await db.from('ops_checks').insert({ status, summary, details })

  // alert only on status CHANGE (incl. recovery) to avoid spam every tick
  let alerted = false
  const { data: prev } = await db.from('ops_checks').select('status').order('created_at', { ascending: false }).range(1, 1).maybeSingle()
  const prevStatus = prev?.status ?? 'ok'
  if (status !== prevStatus && ALERT_BOT && ALERT_CHAT) {
    const icon = status === 'down' ? '🔴' : status === 'warn' ? '🟡' : '✅'
    const lines = Object.entries(details).map(([k, c]) => `${c.ok ? '✅' : '❌'} ${k}: ${c.info}`).join('\n')
    await tgSend(ALERT_BOT, ALERT_CHAT, `${icon} Nemo holati: ${status.toUpperCase()}\n${summary}\n\n${lines}`)
    alerted = true
  }

  return json({ ok: true, status, summary, details, alerted, changedFrom: prevStatus })
})
