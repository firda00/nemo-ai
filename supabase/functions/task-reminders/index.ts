// Scheduled task-reminder sender. Called by pg_cron (~every 15 min) with the
// x-cron-secret header. Finds tasks that are due soon or overdue and not recently
// reminded, then pings the assignee in the Telegram group the task came from and
// stamps last_reminded_at (marking overdue ones). Public (verify_jwt=false) —
// authenticity is the shared cron secret.
//
//   POST /functions/v1/task-reminders   (header: x-cron-secret: <CRON_SECRET>)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { tgSend } from '../_shared/telegram.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''

const H = (ms: number) => new Date(Date.now() + ms).toISOString()

function fmtDue(iso: string): string {
  try { return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) } catch { return iso }
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

  // due within 24h (or already overdue), still open, in a Telegram group
  const { data: tasks } = await db
    .from('tasks')
    .select('id, title, assignee_tg, assignee_name, telegram_chat_id, channel_id, due_at, status, last_reminded_at')
    .neq('status', 'done')
    .not('due_at', 'is', null)
    .not('telegram_chat_id', 'is', null)
    .lte('due_at', soon)
    .limit(200)

  const pending = (tasks ?? []).filter(
    (t) => !t.last_reminded_at || t.last_reminded_at < reminderCutoff,
  )
  if (!pending.length) return new Response(JSON.stringify({ ok: true, reminded: 0 }), { headers: { 'Content-Type': 'application/json' } })

  // resolve bot tokens per channel once
  const channelIds = [...new Set(pending.map((t) => t.channel_id).filter(Boolean))]
  const tokenByChannel = new Map<string, string>()
  if (channelIds.length) {
    const { data: chs } = await db.from('channels').select('id, credentials').in('id', channelIds)
    for (const c of chs ?? []) if (c.credentials?.bot_token) tokenByChannel.set(c.id, c.credentials.bot_token)
  }

  let reminded = 0
  for (const t of pending) {
    const token = t.channel_id ? tokenByChannel.get(t.channel_id) : undefined
    if (!token) continue
    const who = t.assignee_tg || t.assignee_name || 'команда'
    const overdue = t.due_at <= nowIso
    const text = overdue
      ? `⚠️ Просрочено: ${who} — «${t.title}» (срок был ${fmtDue(t.due_at)}).\nОтметьте статус: ответьте «@бот готово».`
      : `⏰ Напоминание: ${who} — «${t.title}», срок ${fmtDue(t.due_at)}.`
    try {
      await tgSend(token, t.telegram_chat_id, text)
      await db.from('tasks').update({
        last_reminded_at: nowIso,
        status: overdue && t.status !== 'overdue' ? 'overdue' : t.status,
      }).eq('id', t.id)
      reminded++
    } catch { /* skip a failed send, try again next tick */ }
  }

  return new Response(JSON.stringify({ ok: true, reminded }), { headers: { 'Content-Type': 'application/json' } })
})
