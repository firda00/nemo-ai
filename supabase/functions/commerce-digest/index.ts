// Read-only commerce notifications. Delivery records are written only after Telegram accepts
// the message; no recommendation is executed or turned into an external marketplace action.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSendHtml } from '../_shared/telegram.ts'
import { escapeHtml } from '../_shared/telegramFormat.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON = Deno.env.get('CRON_SECRET') ?? ''

async function telegramTarget(db: any, accountId: string) {
  const { data: profile } = await db.from('business_profiles').select('notify_chat_id, notify_channel_id').eq('account_id', accountId).maybeSingle()
  if (!profile?.notify_chat_id) return null
  // Send through the bot the owner actually pressed Start on. Any other bot on the account cannot
  // open a conversation, so Telegram would reject the message and the digest would vanish silently.
  if (profile.notify_channel_id) {
    const { data: bound } = await db.from('channels').select('credentials').eq('id', profile.notify_channel_id).maybeSingle()
    const boundToken = bound?.credentials?.bot_token
    if (boundToken) return { token: String(boundToken), chatId: String(profile.notify_chat_id) }
  }
  const { data: agents } = await db.from('agents').select('id').eq('account_id', accountId).limit(20)
  const ids = (agents ?? []).map((agent: { id: string }) => agent.id)
  if (!ids.length) return null
  // Legacy chats bound before notify_channel_id existed: pick deterministically, oldest connected
  // bot first, so behaviour is at least reproducible instead of arbitrary.
  const { data: channel } = await db.from('channels').select('credentials').eq('type', 'telegram').in('agent_id', ids)
    .eq('status', 'connected').order('created_at', { ascending: true }).limit(1).maybeSingle()
  const token = channel?.credentials?.bot_token
  return token ? { token: String(token), chatId: String(profile.notify_chat_id) } : null
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value).toLocaleString('ru-RU') : '—')
const name = (row: any) => `${escapeHtml(String(row.title ?? 'Товар'))} <code>${escapeHtml(String(row.external_sku ?? ''))}</code>`

function criticalText(row: any) {
  const calc = row.calculation ?? {}
  const action = row.suggested_action ?? {}
  return [
    '🔴 <b>Товар заканчивается</b>',
    '',
    name(row),
    `Осталось: <b>${num(calc.stock_total)} шт.</b>`,
    `Хватит примерно на: <b>${num(calc.stock_total != null && calc.daily_velocity ? calc.stock_total / calc.daily_velocity : null)} дн.</b>`,
    `Точка заказа: ${num(calc.reorder_point)} шт.`,
    '',
    `👉 Рекомендуем заказать <b>${num(action.units)} шт.</b>`,
    '',
    '<i>Это рекомендация. Nemo не оформляет заказ и не меняет цену.</i>',
  ].join('\n')
}

function digestLine(row: any) {
  if (row.kind === 'reorder') return `🔴 ${name(row)} — заказать ${num(row.suggested_action?.units)} шт.`
  if (row.kind === 'price_guard') return `💰 ${name(row)} — маржа ниже вашего минимума`
  return `📝 ${name(row)} — не хватает данных для расчёта`
}

function digestText(rows: any[]) {
  const critical = rows.filter((row) => row.severity === 'critical').length
  const missing = rows.filter((row) => row.kind === 'missing_data').length
  const head = critical
    ? `🔴 Срочно: <b>${critical}</b>`
    : '✅ Срочных рисков нет'
  const lines = rows.slice(0, 8).map(digestLine)
  const tail = rows.length > 8 ? `\n…и ещё ${rows.length - 8} в Commerce.` : ''
  // Missing economics is the single thing blocking real reorder/price advice, so say what to do.
  const nudge = missing
    ? `\n\n💡 У <b>${missing}</b> товар(ов) нет себестоимости или срока поставки — без них Nemo не считает закупку и маржу. Продиктуйте прямо сюда, например: «${escapeHtml('XALTA 50*60 себестоимость 20000, доставка 12 дней')}».`
    : ''
  return [
    '☀️ <b>Nemo Commerce — сводка за сутки</b>',
    '',
    head,
    `Всего рекомендаций: <b>${rows.length}</b>`,
    '',
    lines.join('\n') || 'Новых рекомендаций нет.',
    tail,
    nudge,
    '',
    '<i>Nemo ничего не меняет на Uzum автоматически.</i>',
  ].filter((part) => part !== '').join('\n')
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
        if (await tgSendHtml(target.token, target.chatId, criticalText(row))) {
          await db.from('commerce_recommendations').update({ alerted_at: new Date().toISOString() }).eq('id', row.id).is('alerted_at', null)
          sent++
        }
      }
    } else {
      const unsent = accountRows.filter((item) => item.digest_sent_at !== today)
      if (unsent.length && await tgSendHtml(target.token, target.chatId, digestText(unsent))) {
        await db.from('commerce_recommendations').update({ digest_sent_at: today }).in('id', unsent.map((item) => item.id))
        sent++
      }
    }
  }
  return json({ ok: true, action, sent })
})
