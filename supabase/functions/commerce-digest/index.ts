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

function reorderLine(row: any) {
  const calc = row.calculation ?? {}
  const action = row.suggested_action ?? {}
  const days = calc.stock_total != null && calc.daily_velocity ? ` (хватит на ${num(calc.stock_total / calc.daily_velocity)} дн.)` : ''
  const money = action.investment_tiyin != null && action.profit_tiyin != null
    ? `\n  Вложения ${num(action.investment_tiyin / 100)} сум · прибыль ${num(action.profit_tiyin / 100)} сум${action.roi_percent != null ? ` (ROI ${action.roi_percent.toFixed(0)}%)` : ''}`
    : ''
  return `• ${name(row)}: осталось ${num(calc.stock_total)} шт.${days}\n  Заказать <b>${num(action.units)} шт.</b>${money}`
}

function priceLine(row: any) {
  const calc = row.calculation ?? {}
  const floor = calc.min_selling_price_tiyin != null ? ` Минимальная цена ${num(calc.min_selling_price_tiyin / 100)} сум.` : ''
  return `• ${name(row)}: маржа ${num(calc.margin_percent)}% при вашем минимуме ${num(calc.min_margin_percent)}%.${floor}`
}

/**
 * Zero noise: the list contains only what needs a decision today.
 *
 * A hundred "not enough data" lines bury the one product that is actually running out — the
 * seller scrolls past the thing they were supposed to act on. Incomplete economics are real
 * information, but they are a single standing fact about the catalogue, not a hundred events,
 * so they collapse into one closing line that says what to do about it.
 */
function digestText(rows: any[], stats: { skus: number; approximate: number }) {
  const reorders = rows.filter((row) => row.kind === 'reorder')
  const priceIssues = rows.filter((row) => row.kind === 'price_guard')
  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Tashkent' }).format(new Date())

  const blocks: string[] = [`☀️ <b>Nemo Commerce — сводка за ${today}</b>`, '']

  if (!reorders.length && !priceIssues.length) {
    blocks.push(stats.skus ? `✅ Срочных рисков нет. Все ${stats.skus} товаров под наблюдением.` : '✅ Срочных рисков нет.')
  }
  if (reorders.length) {
    blocks.push('🔴 <b>Срочная закупка</b>', reorders.slice(0, 5).map(reorderLine).join('\n'))
    if (reorders.length > 5) blocks.push(`…и ещё ${reorders.length - 5} в Commerce.`)
  }
  if (priceIssues.length) {
    blocks.push('', '💰 <b>Маржа ниже минимума</b>', priceIssues.slice(0, 5).map(priceLine).join('\n'))
    if (priceIssues.length > 5) blocks.push(`…и ещё ${priceIssues.length - 5} в Commerce.`)
  }

  // One line, never a list: the state of the catalogue's economics plus the cheapest way to fix it.
  if (stats.approximate) {
    blocks.push('', `💡 У ${stats.approximate} товаров себестоимость заполнена примерно (≈). Чтобы уточнить цифру по товару, надиктуйте её текстом или голосом прямо в этот чат — например: «${escapeHtml('XALTA 50*60 себестоимость 20000, доставка 12 дней')}».`)
  }

  blocks.push('', '<i>Nemo не меняет цены и не оформляет заказы на Uzum.</i>')
  return blocks.join('\n')
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
  // Catalogue-level facts for the closing line. Counted from the SKUs themselves rather than
  // from recommendations: "113 products carry an estimated cost" is one standing fact, and
  // deriving it from a hundred rows is what produced the wall of text in the first place.
  const statsByAccount = new Map<string, { skus: number; approximate: number }>()
  if (action === 'digest') {
    const { data: catalogs } = await db.from('commerce_catalogs').select('id, account_id').in('account_id', accountIds)
    const accountByCatalog = new Map((catalogs ?? []).map((c: { id: string; account_id: string }) => [c.id, c.account_id]))
    if (accountByCatalog.size) {
      const { data: skuRows } = await db.from('commerce_skus')
        .select('catalog_id, estimated_fields, unit_cost_tiyin').in('catalog_id', [...accountByCatalog.keys()])
      for (const sku of skuRows ?? []) {
        const accountId = accountByCatalog.get(sku.catalog_id)
        if (!accountId) continue
        const current = statsByAccount.get(accountId) ?? { skus: 0, approximate: 0 }
        current.skus += 1
        const estimated = Array.isArray(sku.estimated_fields) ? sku.estimated_fields : []
        if (estimated.length || sku.unit_cost_tiyin == null) current.approximate += 1
        statsByAccount.set(accountId, current)
      }
    }
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
      const stats = statsByAccount.get(accountId) ?? { skus: 0, approximate: 0 }
      if (unsent.length && await tgSendHtml(target.token, target.chatId, digestText(unsent, stats))) {
        await db.from('commerce_recommendations').update({ digest_sent_at: today }).in('id', unsent.map((item) => item.id))
        sent++
      }
    }
  }
  return json({ ok: true, action, sent })
})
