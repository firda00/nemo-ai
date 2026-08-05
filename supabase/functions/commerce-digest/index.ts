// Read-only commerce notifications. Delivery records are written only after Telegram accepts
// the message; no recommendation is executed or turned into an external marketplace action.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSend } from '../_shared/telegram.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON = Deno.env.get('CRON_SECRET') ?? ''

async function telegramTarget(db: any, accountId: string) {
  const { data: profile } = await db.from('business_profiles').select('notify_chat_id').eq('account_id', accountId).maybeSingle()
  if (!profile?.notify_chat_id) return null
  const { data: agents } = await db.from('agents').select('id').eq('account_id', accountId).limit(20)
  const ids = (agents ?? []).map((agent: { id: string }) => agent.id)
  if (!ids.length) return null
  const { data: channel } = await db.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', ids).limit(1).maybeSingle()
  const token = channel?.credentials?.bot_token
  return token ? { token: String(token), chatId: String(profile.notify_chat_id) } : null
}

function criticalText(row: any) {
  const calc = row.calculation ?? {}
  const action = row.suggested_action ?? {}
  return `⚠️ <b>Nemo Commerce: критический риск</b>\n${row.title} (${row.external_sku})\nОстаток: ${calc.stock_total ?? '—'}\nТочка заказа: ${calc.reorder_point ?? '—'}\nРекомендуемая закупка: ${action.units ?? '—'} шт.\n\nЭто рекомендация. Nemo не оформляет заказ и не меняет цену автоматически.`
}

function digestText(rows: any[]) {
  const critical = rows.filter((row) => row.severity === 'critical').length
  const warning = rows.filter((row) => row.severity === 'warning').length
  const lines = rows.slice(0, 5).map((row) => `• ${row.title}: ${row.kind === 'reorder' ? `закупка ${row.suggested_action?.units ?? '—'} шт.` : 'проверьте маржу'}`)
  return `☀️ <b>Nemo Ecommerce Digest</b>\nКритических рисков: ${critical}\nПредупреждений: ${warning}\n\n${lines.join('\n') || 'Новых рекомендаций нет.'}\n\nВсе рекомендации доступны в Commerce. Внешние действия не выполняются автоматически.`
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  const auth = req.headers.get('Authorization') ?? ''
  const cron = req.headers.get('x-cron-secret') ?? ''
  if (auth !== `Bearer ${SERVICE}` && (!CRON || cron !== CRON)) return json({ error: 'forbidden' }, 403)
  const body = await req.json().catch(() => ({}))
  const action = body?.action === 'alerts' ? 'alerts' : 'digest'
  const db = createClient(URL, SERVICE)
  const { data: pilots, error: pilotError } = await db.from('commerce_pilots').select('account_id').eq('status', 'active').gt('expires_at', new Date().toISOString())
  if (pilotError) return json({ error: 'pilot_lookup_failed' }, 500)
  const accountIds = (pilots ?? []).map((pilot: { account_id: string }) => pilot.account_id)
  if (!accountIds.length) return json({ ok: true, sent: 0 })
  const { data: rows, error } = await db.from('commerce_recommendations')
    .select('id, severity, kind, calculation, suggested_action, alerted_at, digest_sent_at, commerce_skus!inner(external_sku, title, commerce_catalogs!inner(account_id))')
    .eq('status', 'open').in('commerce_skus.commerce_catalogs.account_id', accountIds).order('created_at', { ascending: false }).limit(500)
  if (error) return json({ error: 'recommendation_lookup_failed' }, 500)
  const byAccount = new Map<string, any[]>()
  for (const row of rows ?? []) {
    const sku = row.commerce_skus
    const accountId = sku?.commerce_catalogs?.account_id
    if (!accountId) continue
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), { ...row, ...sku }])
  }
  let sent = 0
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date())
  for (const [accountId, accountRows] of byAccount) {
    if (await blocksExternalActions(db, accountId)) continue
    const target = await telegramTarget(db, accountId)
    if (!target) continue
    if (action === 'alerts') {
      for (const row of accountRows.filter((item) => item.severity === 'critical' && !item.alerted_at)) {
        if (await tgSend(target.token, target.chatId, criticalText(row))) {
          await db.from('commerce_recommendations').update({ alerted_at: new Date().toISOString() }).eq('id', row.id).is('alerted_at', null)
          sent++
        }
      }
    } else {
      const unsent = accountRows.filter((item) => item.digest_sent_at !== today)
      if (unsent.length && await tgSend(target.token, target.chatId, digestText(unsent))) {
        await db.from('commerce_recommendations').update({ digest_sent_at: today }).in('id', unsent.map((item) => item.id))
        sent++
      }
    }
  }
  return json({ ok: true, action, sent })
})
