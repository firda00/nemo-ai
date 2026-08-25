// Weekly stand-up scorecard agent — "the platform grades the week by itself". Called by
// pg_cron (Monday morning) with x-cron-secret. For every Telegram team group with task
// activity, posts ONE per-person scorecard to that group: took / done / % / overdue (with
// the missed-day count). Language per business_profiles.report_lang. Visible accountability.
//   POST /functions/v1/weekly-report   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'
import { L, normLang, type Lang } from '../_shared/planerkaLocale.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const NEMO_URL = Deno.env.get('APP_URL') ?? 'https://nemo-ai-swart.vercel.app'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const isFreeTier = (p?: string) => !p || ['free', 'beta', ''].includes(String(p))

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const secret = req.headers.get('x-cron-secret')
  const auth = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) {
    return new Response('forbidden', { status: 403 })
  }
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  const { data: rows, error } = await db.rpc('planerka_weekly_scorecard')
  if (error) return json({ ok: false, error: error.message }, 500)
  // keep only people with any activity this week (took, closed or still open/overdue)
  const active = ((rows ?? []) as Any[]).filter((r) =>
    Number(r.assigned) + Number(r.done) + Number(r.open_cnt) > 0)
  if (active.length === 0) return json({ ok: true, chats: 0, sent: 0 })

  const accountIds = [...new Set(active.map((r) => r.account_id).filter(Boolean))]
  const blockedAccounts = new Set((await Promise.all(accountIds.map(async (accountId) =>
    await blocksExternalActions(db, accountId) ? accountId : null))).filter(Boolean))
  const deliveryRows = active.filter((r) => !blockedAccounts.has(r.account_id))
  const deliveryChatIds = [...new Set(deliveryRows.map((r) => r.telegram_chat_id).filter(Boolean))]

  // resolve the group bot token per (account, chat) — a chat_id can belong to two accounts
  // (both bots in one group), so we must NOT collapse on chat alone or one account's scorecard
  // would be posted through the other's bot. Key everything on `${account_id}::${chat_id}`.
  let chatCh: Any[] = []
  if (deliveryChatIds.length) {
    const { data } = await db.from('tasks')
      .select('account_id, telegram_chat_id, channel_id').in('telegram_chat_id', deliveryChatIds).not('channel_id', 'is', null)
    chatCh = data ?? []
  }
  const channelByKey = new Map<string, string>()
  for (const t of chatCh) {
    if (blockedAccounts.has(t.account_id)) continue
    const key = `${t.account_id}::${t.telegram_chat_id}`
    if (!channelByKey.has(key)) channelByKey.set(key, t.channel_id)
  }

  const channelIds = [...new Set([...channelByKey.values()])]
  const tokenByChannel = new Map<string, string>()
  if (channelIds.length) {
    const { data: chs } = await db.from('channels').select('id, credentials, scope').in('id', channelIds)
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

  // group scorecard rows by (account, chat) so each tenant's card is built + sent separately
  const byKey = new Map<string, Any[]>()
  for (const r of active) {
    const key = `${r.account_id}::${r.telegram_chat_id}`
    const arr = byKey.get(key) ?? []
    arr.push(r)
    byKey.set(key, arr)
  }

  let sent = 0
  for (const [key, people] of byKey) {
    try {
      const [accId, chatId] = key.split('::')
      const channelId = channelByKey.get(key)
      const token = channelId ? tokenByChannel.get(channelId) : undefined
      if (!token) continue
      const lang = langByAcc.get(accId) ?? 'ru'
      const d = L(lang)
      // worst offenders first: most overdue, then most open
      people.sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || (Number(b.open_cnt) - Number(a.open_cnt)))
      const lines = people.map((r) => {
        const assigned = Number(r.assigned), done = Number(r.done)
        const pct = assigned > 0 ? Math.round((done / assigned) * 100) : (done > 0 ? 100 : 0)
        return d.weeklyPersonLine(r.assignee, assigned, done, pct, Number(r.overdue), Number(r.max_overdue_days))
      })
      let body = `${d.weeklyHeader}\n\n${lines.join('\n')}${d.weeklyFooter}`
      if (isFreeTier(planByAcc.get(accId))) body += d.poweredBy(NEMO_URL)
      if (await blocksExternalActions(db, accId)) continue
      if (await tgSend(token, chatId, body)) sent++
    } catch { /* best effort per chat */ }
  }

  return json({ ok: true, chats: byKey.size, sent })
})
