// Autonomous ops watchdog — "an agent keeps the site up and watches support".
// Called by pg_cron (~every 10 min) with x-cron-secret. Checks the site, the VPS worker,
// the database and the support queue, writes one ops_checks row, and — only when the overall
// status CHANGES — sends a Telegram alert to the admin (so no spam every tick). Recovery is
// announced too. Configure OPS_ALERT_BOT_TOKEN + OPS_ALERT_CHAT_ID to receive alerts.
//   POST /functions/v1/ops-watchdog   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'
import { memoryHealthVerdict } from '../_shared/orgMemory.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const SITE_URL = (Deno.env.get('SITE_URL') ?? 'https://nemo.185.8.213.144.sslip.io').replace(/\/$/, '')
const RENDER_WORKER_URL = (Deno.env.get('RENDER_WORKER_URL') ?? '').replace(/\/$/, '')
const RENDER_SECRET = Deno.env.get('RENDER_SECRET') ?? ''
const ALERT_BOT = Deno.env.get('OPS_ALERT_BOT_TOKEN') ?? ''
const ALERT_CHAT = Deno.env.get('OPS_ALERT_CHAT_ID') ?? ''
// Mirrors src/lib/opsHealth.ts — the UI calls a status stale on the same schedule.
const CHECK_INTERVAL_MINUTES = 10
const MISSED_INTERVALS_BEFORE_ALERT = 3
const STUCK_JOB_MINUTES = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Check = { ok: boolean; info: string }
async function timed(fn: () => Promise<Check>, timeoutMs = 8000): Promise<Check> {
  try {
    return await Promise.race([fn(), new Promise<Check>((_, r) => setTimeout(() => r(new Error('timeout')), timeoutMs))])
  } catch (e) { return { ok: false, info: String((e as Error)?.message ?? e).slice(0, 120) } }
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
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

  // 6) dead-letter sweep — a browser task that returned pending wrote result='running' and
  // nothing ever revisited it, so one has been "running" since 18 July. Close them out here:
  // a job with no owner and no timeout is indistinguishable from a job still doing work.
  details.stuck_jobs = await timed(async () => {
    const cutoff = new Date(Date.now() - STUCK_JOB_MINUTES * 60_000).toISOString()
    const { data: swept, error } = await db.from('tool_runs')
      .update({ result: 'timeout', ok: false })
      .eq('tool', 'browser_task').eq('result', 'running').lt('created_at', cutoff)
      .select('id')
    if (error) return { ok: false, info: `sweep failed: ${error.message.slice(0, 80)}` }
    const n = swept?.length ?? 0
    return { ok: true, info: n ? `${n} ta osilgan vazifa yopildi` : 'osilgan vazifa yo`q' }
  })

  // 7) organizational memory — is the recall path alive, or quietly returning nothing forever?
  //
  // Recall degrades softly by design: it cannot fail a run, so a broken embedding service and an
  // empty memory both produce the same empty list. That is the shape of failure this project
  // keeps meeting — silence that reads as calm — so the distinction is recorded at the source and
  // judged here, in a process that does not depend on the memory working.
  details.org_memory = await timed(async () => {
    const { data, error } = await db.rpc('org_memory_health_window', { p_days: 2 })
    if (error) return { ok: false, info: `rpc error: ${error.message.slice(0, 80)}` }
    const row = (Array.isArray(data) ? data[0] : data) ?? {}
    const verdict = memoryHealthVerdict({
      attempts: Number(row.attempts ?? 0),
      successes: Number(row.successes ?? 0),
      empties: Number(row.empties ?? 0),
      embed_failures: Number(row.embed_failures ?? 0),
      query_failures: Number(row.query_failures ?? 0),
    })
    const tail = verdict.ok || !row.last_error ? '' : ` · ${String(row.last_error).slice(0, 60)}`
    return { ok: verdict.ok, info: `${verdict.state}: ${verdict.info}${tail}` }
  })

  // The monitor's own liveness, read BEFORE writing this tick. pg_cron was configured
  // correctly and still stopped writing for twelve days while the newest row said `ok` —
  // so a gap in this table is itself an incident and must alert even when nothing changed.
  const { data: previous } = await db.from('ops_checks')
    .select('status, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const prevStatus = previous?.status ?? 'ok'
  const gapMinutes = previous?.created_at
    ? Math.round((Date.now() - Date.parse(String(previous.created_at))) / 60_000)
    : null
  const missedRuns = gapMinutes != null && gapMinutes > CHECK_INTERVAL_MINUTES * MISSED_INTERVALS_BEFORE_ALERT

  // overall status: down if site/DB down; warn if worker/support/cost/sweep need attention
  const hard = details.database.ok && details.site.ok
  const soft = details.worker.ok && details.support.ok && details.cost.ok && details.stuck_jobs.ok
  const status = !hard ? 'down' : soft ? 'ok' : 'warn'
  const failing = Object.entries(details).filter(([, c]) => !c.ok).map(([k]) => k)
  const summary = status === 'ok' ? 'Hammasi ishlayapti' : `Muammo: ${failing.join(', ')}`

  await db.from('ops_checks').insert({ status, summary, details })

  // Alert on a status CHANGE (incl. recovery) or on a monitoring gap — the second one is how
  // a dead watchdog announces itself once it comes back, instead of resuming silently.
  let alerted = false
  if ((status !== prevStatus || missedRuns) && ALERT_BOT && ALERT_CHAT) {
    const icon = status === 'down' ? '🔴' : status === 'warn' ? '🟡' : '✅'
    const lines = Object.entries(details).map(([k, c]) => `${c.ok ? '✅' : '❌'} ${k}: ${c.info}`).join('\n')
    const gapLine = missedRuns ? `\n⚠️ Monitoring ${gapMinutes} daqiqa yozmagan — tekshiruvlar to'xtagan edi.` : ''
    await tgSend(ALERT_BOT, ALERT_CHAT, `${icon} Nemo holati: ${status.toUpperCase()}\n${summary}${gapLine}\n\n${lines}`)
    alerted = true
  }

  return json({ ok: true, status, summary, details, alerted, changedFrom: prevStatus, gapMinutes, missedRuns })
})
