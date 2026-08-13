// Scheduled task-reminder sender. Called by pg_cron (~every 15 min) with the
// x-cron-secret header. Finds tasks that are due soon or overdue and not recently
// reminded, then pings the assignee in the Telegram group the task came from and
// stamps last_reminded_at (marking overdue ones). Public (verify_jwt=false) —
// authenticity is the shared cron secret.
//
//   POST /functions/v1/task-reminders   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { tgSend } from '../_shared/telegram.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const H = (ms: number) => new Date(Date.now() + ms).toISOString()

// Localized reminder copy — an Uzbek team should get Uzbek reminders (UZ is the product default).
const LOC = {
  uz: { header: '⏰ Bugungi vazifalar boʻyicha eslatma:', overdue: 'muddati oʻtdi', due: 'muddat', team: 'jamoa', foot: 'Bajarilganini belgilang: «@bot tayyor».', locale: 'uz' },
  ru: { header: '⏰ Напоминание по задачам:', overdue: 'просрочено', due: 'срок', team: 'команда', foot: 'Отметьте готовые: «@бот готово».', locale: 'ru-RU' },
  en: { header: '⏰ Task reminder:', overdue: 'overdue', due: 'due', team: 'team', foot: 'Mark done: “@bot done”.', locale: 'en-GB' },
} as const
const normLang = (l: unknown): keyof typeof LOC => (l === 'ru' || l === 'en' || l === 'uz') ? l : 'uz'

function fmtDate(iso: string, locale: string): string {
  try { return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short' }) } catch { return iso.slice(0, 10) }
}

Deno.serve(async (req) => {
  // allow cron (secret header) OR a service-role bearer (manual trigger)
  const secret = req.headers.get('x-cron-secret')
  const auth = req.headers.get('Authorization') ?? ''
  if (!CRON_SECRET || (secret !== CRON_SECRET && auth !== `Bearer ${SERVICE_ROLE}`)) {
    return new Response('forbidden', { status: 403 })
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE)
  const nowIso = new Date().toISOString()
  const soon = H(24 * 3600 * 1000)          // remind up to 24h before due
  const reminderCutoff = H(-12 * 3600 * 1000) // don't re-remind within 12h

  // still open, with a Telegram destination, and a due date in either due_at OR deadline (date).
  const { data: tasks } = await db
    .from('tasks')
    .select('id, account_id, title, assignee_tg, assignee_name, telegram_chat_id, channel_id, due_at, deadline, status, last_reminded_at')
    .neq('status', 'done')
    .not('telegram_chat_id', 'is', null)
    .or('due_at.not.is.null,deadline.not.is.null')
    .limit(300)

  // effective due: due_at if present, else end-of-day of the deadline date.
  const effDue = (t: { due_at: string | null; deadline: string | null }): string | null =>
    t.due_at ?? (t.deadline ? `${t.deadline}T23:59:00.000Z` : null)

  const pending = (tasks ?? []).filter((t) => {
    const due = effDue(t)
    if (!due || due > soon) return false // not due within 24h yet
    return !t.last_reminded_at || t.last_reminded_at < reminderCutoff
  })
  if (!pending.length) return new Response(JSON.stringify({ ok: true, reminded: 0 }), { headers: { 'Content-Type': 'application/json' } })

  const accountIds = [...new Set(pending.map((t) => t.account_id).filter(Boolean))]
  const blockedAccounts = new Set((await Promise.all(accountIds.map(async (accountId) =>
    await blocksExternalActions(db, accountId) ? accountId : null))).filter(Boolean))
  const deliveryPending = pending.filter((t) => !blockedAccounts.has(t.account_id))

  // resolve bot tokens per channel once
  const channelIds = [...new Set(deliveryPending.map((t) => t.channel_id).filter(Boolean))]
  const tokenByChannel = new Map<string, string>()
  if (channelIds.length) {
    const { data: chs } = await db.from('channels').select('id, credentials').in('id', channelIds)
    for (const c of chs ?? []) if (c.credentials?.bot_token) tokenByChannel.set(c.id, c.credentials.bot_token)
  }

  // resolve each account's language once (so an Uzbek team gets Uzbek reminders)
  const langByAccount = new Map<string, keyof typeof LOC>()
  if (accountIds.length) {
    const { data: bps } = await db.from('business_profiles').select('account_id, report_lang').in('account_id', accountIds)
    for (const b of bps ?? []) langByAccount.set(b.account_id, normLang(b.report_lang))
  }

  // Group due tasks by chat and send ONE digest per group instead of spamming a message per task.
  const groups = new Map<string, { accountId: string; token: string; chatId: string; lang: keyof typeof LOC; items: typeof pending }>()
  for (const t of deliveryPending) {
    const token = t.channel_id ? tokenByChannel.get(t.channel_id) : undefined
    if (!token) continue
    const key = `${t.channel_id}|${t.telegram_chat_id}`
    if (!groups.has(key)) groups.set(key, { accountId: t.account_id, token, chatId: String(t.telegram_chat_id), lang: langByAccount.get(t.account_id) ?? 'uz', items: [] })
    groups.get(key)!.items.push(t)
  }

  let reminded = 0
  for (const g of groups.values()) {
    const L = LOC[g.lang]
    const lines = g.items.map((t, i) => {
      const due = effDue(t) ?? nowIso
      const overdue = due <= nowIso
      const who = t.assignee_tg || t.assignee_name || L.team
      return `${i + 1}. ${overdue ? '⚠️' : '•'} ${who} — «${t.title}» — ${overdue ? L.overdue : L.due} ${fmtDate(due, L.locale)}`
    })
    try {
      if (await blocksExternalActions(db, g.accountId)) continue
      await tgSend(g.token, g.chatId, `${L.header}\n${lines.join('\n')}\n${L.foot}`)
      for (const t of g.items) {
        const overdue = (effDue(t) ?? nowIso) <= nowIso
        await db.from('tasks').update({
          last_reminded_at: nowIso,
          status: overdue && t.status !== 'overdue' ? 'overdue' : t.status,
        }).eq('id', t.id)
        reminded++
      }
    } catch { /* skip this group, try again next tick */ }
  }

  return new Response(JSON.stringify({ ok: true, reminded, groups: groups.size }), { headers: { 'Content-Type': 'application/json' } })
})
