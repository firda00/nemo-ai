// Morning brief agent — "the platform runs the stand-up itself". Called by pg_cron each
// morning with x-cron-secret. For every Telegram group that has open tasks, posts one
// message: today's plan grouped by person, with a missed-day counter on overdue tasks
// (each extra day late shows as "overdue N days"). Language per business_profiles.report_lang.
//   POST /functions/v1/morning-brief   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSend, tgSendVoice } from '../_shared/telegram.ts'
import { L, normLang, fmtDate, overdueDays, type Lang } from '../_shared/planerkaLocale.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'
import { elevenTTS, openaiTTS, uploadAudio } from '../_shared/media.ts'
import { generateMorningBriefSummary } from '../../../src/lib/voice/morning-brief.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const NEMO_URL = Deno.env.get('APP_URL') ?? 'https://nemo-ai-swart.vercel.app'
const AUDIO_ENABLED = Deno.env.get('MORNING_BRIEF_AUDIO_ENABLED') === 'true'
const ELEVEN_KEY = Deno.env.get('ELEVENLABS_API_KEY') ?? ''
const OPENAI_KEY = Deno.env.get('OPENAI_API_KEY') ?? ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
// free-tier accounts carry a subtle "powered by Nemo" footer (PLG growth loop); paid = clean
const isFreeTier = (p?: string) => !p || ['free', 'beta', ''].includes(String(p))

// Telegram rejects messages over 4096 chars. Split on line boundaries and send in order,
// so a big group's brief is never silently dropped. Returns true if every chunk sent.
async function sendLong(db: Any, accountId: string, token: string, chatId: string, text: string): Promise<boolean> {
  const LIMIT = 3800
  if (text.length <= LIMIT) return !(await blocksExternalActions(db, accountId)) && await tgSend(token, chatId, text)
  const chunks: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > LIMIT && cur) { chunks.push(cur); cur = line } else { cur = cur ? cur + '\n' + line : line }
  }
  if (cur) chunks.push(cur)
  let ok = true
  for (const c of chunks) {
    if (await blocksExternalActions(db, accountId)) return false
    ok = (await tgSend(token, chatId, c)) && ok
  }
  return ok
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
  const nowMs = Date.now()

  // all open tasks that came from a Telegram group
  const { data: tasks, error } = await db
    .from('tasks')
    .select('id, account_id, channel_id, telegram_chat_id, title, assignee_tg, assignee_name, due_at, status')
    .neq('status', 'done')
    .not('telegram_chat_id', 'is', null)
    .order('telegram_chat_id', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(2000)
  if (error) return json({ ok: false, error: error.message }, 500)
  if (!tasks?.length) return json({ ok: true, groups: 0, sent: 0 })

  // resolve bot token per channel + report language per account
  const accountIds = [...new Set((tasks as Any[]).map((t) => t.account_id).filter(Boolean))]
  const blockedAccounts = new Set((await Promise.all(accountIds.map(async (accountId) =>
    await blocksExternalActions(db, accountId) ? accountId : null))).filter(Boolean))
  const deliveryTasks = (tasks as Any[]).filter((t) => !blockedAccounts.has(t.account_id))
  const deliveryChannelIds = [...new Set(deliveryTasks.map((t) => t.channel_id).filter(Boolean))]
  const tokenByChannel = new Map<string, string>()
  if (deliveryChannelIds.length) {
    const { data: chs } = await db.from('channels').select('id, credentials, scope').in('id', deliveryChannelIds)
    for (const c of (chs ?? []) as Any[]) if (c.scope === 'group' && c.credentials?.bot_token) tokenByChannel.set(c.id, c.credentials.bot_token)
  }
  const langByAcc = new Map<string, Lang>()
  const planByAcc = new Map<string, string>()
  if (accountIds.length) {
    const { data: bps } = await db.from('business_profiles').select('account_id, report_lang').in('account_id', accountIds)
    for (const b of (bps ?? []) as Any[]) langByAcc.set(b.account_id, normLang(b.report_lang))
    const { data: accs } = await db.from('accounts').select('id, plan').in('id', accountIds)
    for (const a of (accs ?? []) as Any[]) planByAcc.set(a.id, String(a.plan ?? 'free'))
  }

  // group tasks by (channel_id + chat_id)
  const groups = new Map<string, Any[]>()
  for (const t of deliveryTasks) {
    if (!t.channel_id || !tokenByChannel.has(t.channel_id)) continue // only groups with a live task-bot
    const key = `${t.channel_id}::${t.telegram_chat_id}`
    const arr = groups.get(key) ?? []
    arr.push(t)
    groups.set(key, arr)
  }

  let sent = 0
  const audioByAccount = new Map<string, string>()
  for (const [key, list] of groups) {
    try {
      const [channelId, chatId] = key.split('::')
      const token = tokenByChannel.get(channelId)!
      const lang = langByAcc.get(list[0].account_id) ?? 'ru'
      const d = L(lang)

      // bucket by assignee, overdue-first then by due date
      const byWho = new Map<string, Any[]>()
      for (const t of list) {
        const who = t.assignee_tg || t.assignee_name || '—'
        const arr = byWho.get(who) ?? []
        arr.push(t)
        byWho.set(who, arr)
      }
      const sortTasks = (a: Any, b: Any) => {
        const oa = overdueDays(a.due_at, nowMs), ob = overdueDays(b.due_at, nowMs)
        if ((oa > 0) !== (ob > 0)) return oa > 0 ? -1 : 1
        return (Date.parse(a.due_at ?? '') || Infinity) - (Date.parse(b.due_at ?? '') || Infinity)
      }

      let body = d.briefHeader
      for (const [who, wtasks] of byWho) {
        body += d.briefPersonHeader(who)
        for (const t of wtasks.sort(sortTasks)) {
          const od = overdueDays(t.due_at, nowMs)
          body += '\n' + d.briefTaskLine(t.title, t.due_at ? fmtDate(t.due_at, lang) : '') + (od > 0 ? d.overdueBadge(od) : '')
        }
      }
      body += d.briefFooter
      if (isFreeTier(planByAcc.get(list[0].account_id))) body += d.poweredBy(NEMO_URL)
      const accountId = String(list[0].account_id)
      // Audio is opt-in and paid-plan only: scheduled TTS must never create surprise provider
      // spend for a free workspace. One synthesized artifact is reused for all of the account's
      // Telegram groups during this run.
      if (AUDIO_ENABLED && !isFreeTier(planByAcc.get(accountId)) && (ELEVEN_KEY || OPENAI_KEY)) {
        let audioUrl = audioByAccount.get(accountId) ?? ''
        if (!audioUrl) {
          const since = new Date(nowMs); since.setHours(0, 0, 0, 0)
          const [leads, activeRuns, approvals] = await Promise.all([
            db.from('leads').select('id', { count: 'exact', head: true }).eq('account_id', accountId).gte('created_at', since.toISOString()),
            // waiting_compute — активные документные задания входят в «активные прогоны»
            db.schema('runtime').from('workflow_runs').select('id', { count: 'exact', head: true }).eq('account_id', accountId).in('current_state', ['queued', 'running', 'waiting_for_action', 'waiting_compute']),
            db.from('approval_requests').select('id', { count: 'exact', head: true }).eq('account_id', accountId).eq('status', 'pending'),
          ])
          const summary = await generateMorningBriefSummary(accountId, {
            getDailyMetrics: async () => ({
              leadsToday: leads.count ?? 0,
              activeCampaigns: activeRuns.count ?? 0,
              completedAgentTasks: 0,
              pendingAgentTasks: list.length,
              approvalsWaiting: approvals.count ?? 0,
            }),
          })
          let audio = ELEVEN_KEY ? await elevenTTS(ELEVEN_KEY, summary.text) : ''
          if (!audio && OPENAI_KEY) audio = await openaiTTS(OPENAI_KEY, summary.text)
          audioUrl = audio ? await uploadAudio(db, accountId, audio) : ''
          if (audioUrl) audioByAccount.set(accountId, audioUrl)
        }
        if (audioUrl && !await blocksExternalActions(db, accountId)) {
          await tgSendVoice(token, chatId, audioUrl, 'Утренняя бизнес-сводка Nemo')
        }
      }
      if (await sendLong(db, list[0].account_id, token, chatId, body)) sent++
    } catch { /* best effort per group */ }
  }

  return json({ ok: true, groups: groups.size, sent })
})
