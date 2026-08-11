// Read-only commerce notifications. Delivery records are written only after Telegram accepts
// the message; no recommendation is executed or turned into an external marketplace action.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { tgSendHtml, tgSendKeyboard } from '../_shared/telegram.ts'
import { escapeHtml } from '../_shared/telegramFormat.ts'
import { adviceForDeadstock, adviceForMargin, adviceMessage } from '../_shared/priceTarget.ts'
import { priceKeyboard } from '../_shared/commercePriceChat.ts'
import { entitlementFor } from '../_shared/entitlement.ts'
import { blocksExternalActions } from '../_shared/productionE2E.ts'
import { staleCatalogues, staleWarningText, brokenCatalogues, emptyNotice, type CatalogueFreshness } from '../_shared/commerceFreshness.ts'

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
  const footer = ['', '<i>Это рекомендация. Nemo не оформляет заказ и не меняет цену.</i>']

  // A stockout has no velocity, no reorder point and no suggested quantity — the reorder planner
  // computes those and needs a week of history it does not have. Rendering this with the reorder
  // wording produced "Хватит примерно на — дн." and "Рекомендуем заказать — шт.": three empty
  // fields and no reason to act. Each kind gets the sentence its own facts support.
  if (row.kind === 'stockout') {
    return [
      '🔴 <b>Товар закончился</b>',
      '',
      name(row),
      'Остаток: <b>0 шт.</b>',
      calc.sold_units_7d ? `Продано за последнюю неделю: <b>${num(calc.sold_units_7d)} шт.</b>` : '',
      calc.price_tiyin ? `Цена на витрине: ${num(calc.price_tiyin / 100)} сум` : '',
      '',
      '👉 Спрос есть, а продавать нечего — стоит пополнить.',
      ...footer,
    ].filter(Boolean).join('\n')
  }

  // Застой — противоположность закупке, и без своей ветки он вышел бы отсюда со словами
  // «Рекомендуем заказать N шт.» про товар, который и так лежит.
  if (row.kind === 'deadstock') {
    return [
      '🧊 <b>Товар лежит без движения</b>',
      '',
      name(row),
      `Остаток: <b>${num(calc.stock_total)} шт.</b>`,
      `Без единой продажи: <b>${num(calc.days_observed)} дн. наблюдений</b>`,
      calc.price_tiyin != null && calc.stock_total != null
        ? `Заморожено в товаре: ~${num((calc.price_tiyin * calc.stock_total) / 100)} сум`
        : '',
      '',
      '👉 Снизить цену, поставить в акцию или вывезти со склада — он платит за хранение.',
      ...footer,
    ].filter(Boolean).join('\n')
  }

  return [
    '🔴 <b>Товар заканчивается</b>',
    '',
    name(row),
    `Осталось: <b>${num(calc.stock_total)} шт.</b>`,
    `Хватит примерно на: <b>${num(daysLeft(calc))} дн.</b>`,
    `Точка заказа: ${num(calc.reorder_point)} шт.`,
    '',
    `👉 Рекомендуем заказать <b>${num(action.units)} шт.</b>`,
    ...footer,
  ].join('\n')
}

/** Сколько дней осталось: посчитанное воркером, а на старых строках — выведенное здесь. */
const daysLeft = (calc: any) =>
  calc.days_left ?? (calc.stock_total != null && calc.daily_velocity ? calc.stock_total / calc.daily_velocity : null)

/**
 * Товар лежит и платит за хранение.
 *
 * Без срока это была бы жалоба, а не повод: «не продаётся» верно про половину каталога в любой
 * вторник. Поэтому в строке стоит число НАБЛЮДАВШИХСЯ дней — то, чем детектор обосновал вывод.
 */
function deadstockLine(row: any) {
  const calc = row.calculation ?? {}
  const money = calc.price_tiyin != null && calc.stock_total != null
    ? `, заморожено ~${num((calc.price_tiyin * calc.stock_total) / 100)} сум`
    : ''
  return `• ${name(row)}: ${num(calc.stock_total)} шт. лежат ${num(calc.days_observed)} дн. без продаж${money}`
}

function reorderLine(row: any) {
  const calc = row.calculation ?? {}
  const action = row.suggested_action ?? {}
  const left = daysLeft(calc)
  const days = left != null ? ` (хватит на ${num(left)} дн.)` : ''
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
function stockoutLine(row: any) {
  const calc = row.calculation ?? {}
  const sold = calc.sold_units_7d
  return `• ${name(row)}: остаток 0${sold ? `, продано за неделю ${num(sold)} шт.` : ''}`
}

/**
 * Ценовые советы с кнопками — по одному сообщению на товар.
 *
 * Считается ровно тем же движком, что и везде: своей алгебры здесь нет, иначе кнопка предложила
 * бы одно число, а утренняя сводка назвала бы его убыточным.
 *
 * Совет без пола не отправляется вовсе. Кнопка «Принять» под ценой, которую не с чем сравнить,
 * означала бы «согласитесь вслепую», и база такое всё равно отвергнет — лучше не спрашивать.
 */
const ADVICE_PER_RUN = 3

async function sendPriceAdvice(db: any, target: { token: string; chatId: string }, rows: any[]): Promise<number> {
  let sent = 0
  // Не больше трёх советов за прогон, и это не вкусовщина, а цена ошибки: у отправки не было
  // предела, ручной запуск на всём каталоге выдал 78 сообщений с кнопками подряд, и владелец
  // получил ровно ту стену, против которой построено правило Zero Noise. Кнопка требует решения
  // по каждому товару — семьдесят восемь решений подряд не принимает никто, и все они
  // превращаются в непрочитанное.
  //
  // Первыми идут те, где на кону больше денег: разрыв между нынешней ценой и рекомендуемой.
  const candidates = rows
    .filter((row) => !row.advice_sent_at && row.status === 'open' && (row.kind === 'price_guard' || row.kind === 'deadstock'))
    .sort((a, b) => Math.abs(Number(b.calculation?.min_selling_price_tiyin ?? 0) - Number(b.calculation?.price_tiyin ?? 0))
                  - Math.abs(Number(a.calculation?.min_selling_price_tiyin ?? 0) - Number(a.calculation?.price_tiyin ?? 0)))
  for (const row of candidates) {
    if (sent >= ADVICE_PER_RUN) break
    const calc = row.calculation ?? {}
    const fees = {
      commission_percent: Number(calc.commission_percent ?? calc.fees?.commission_percent ?? NaN),
      returns_reserve_percent: Number(calc.returns_reserve_percent ?? calc.fees?.returns_reserve_percent ?? 0),
      fulfillment_tiyin: Number(calc.fulfillment_tiyin ?? calc.fees?.fulfillment_tiyin ?? NaN),
    }
    const cost = Number(calc.unit_cost_tiyin ?? NaN)
    const price = Number(calc.price_tiyin ?? 0)
    const minMargin = Number(calc.min_margin_percent ?? NaN)
    if (![fees.commission_percent, fees.fulfillment_tiyin, cost, minMargin].every(Number.isFinite)) continue

    const advice = row.kind === 'price_guard'
      ? adviceForMargin({ currentTiyin: price, unitCostTiyin: cost, minMarginPercent: minMargin, targetMarginPercent: minMargin + 10, fees })
      : adviceForDeadstock({ currentTiyin: price, unitCostTiyin: cost, minMarginPercent: minMargin, fees })
    if (!advice) continue

    const title = String(row.commerce_skus?.title ?? row.commerce_skus?.external_sku ?? 'товар')
    const ok = await tgSendKeyboard(
      target.token, target.chatId,
      adviceMessage(escapeHtml(title), advice, Array.isArray(calc.estimated_inputs) ? calc.estimated_inputs : []),
      { inline_keyboard: priceKeyboard(row.id, advice.target_tiyin) },
    )
    if (!ok) continue
    await db.from('commerce_recommendations')
      .update({ advice_sent_at: new Date().toISOString() })
      .eq('id', row.id).is('advice_sent_at', null)
    sent++
  }
  return sent
}

function digestText(rows: any[], stats: { skus: number; approximate: number }) {
  const reorders = rows.filter((row) => row.kind === 'reorder')
  const priceIssues = rows.filter((row) => row.kind === 'price_guard')
  // A SKU at zero that sold last week is losing orders today; one that never sold may simply be
  // finished. Only the first is a decision, so only the first is listed — the rest are one line,
  // because ninety-four bullet points is a wall, not a briefing.
  const stockouts = rows.filter((row) => row.kind === 'stockout')
  const urgentStockouts = stockouts.filter((row) => row.severity === 'critical')
  const quietStockouts = stockouts.length - urgentStockouts.length
  const deadstock = rows.filter((row) => row.kind === 'deadstock')
  const today = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Asia/Tashkent' }).format(new Date())

  const blocks: string[] = [`☀️ <b>Nemo Commerce — сводка за ${today}</b>`, '']

  if (!reorders.length && !priceIssues.length && !stockouts.length && !deadstock.length) {
    blocks.push(stats.skus ? `✅ Срочных рисков нет. Все ${stats.skus} товаров под наблюдением.` : '✅ Срочных рисков нет.')
  }
  if (urgentStockouts.length) {
    blocks.push('📦 <b>Закончились, а спрос есть</b>', urgentStockouts.slice(0, 5).map(stockoutLine).join('\n'))
    if (urgentStockouts.length > 5) blocks.push(`…и ещё ${urgentStockouts.length - 5} в Commerce.`)
  }
  if (reorders.length) {
    blocks.push('🔴 <b>Срочная закупка</b>', reorders.slice(0, 5).map(reorderLine).join('\n'))
    if (reorders.length > 5) blocks.push(`…и ещё ${reorders.length - 5} в Commerce.`)
  }
  if (priceIssues.length) {
    blocks.push('', '💰 <b>Маржа ниже минимума</b>', priceIssues.slice(0, 5).map(priceLine).join('\n'))
    if (priceIssues.length > 5) blocks.push(`…и ещё ${priceIssues.length - 5} в Commerce.`)
  }
  // Застой идёт последним намеренно: он не срочен. Деньги там теряются медленно, и поставить его
  // выше «закончился, а спрос есть» значило бы предложить владельцу заняться этим первым.
  if (deadstock.length) {
    blocks.push('', '🧊 <b>Лежит без движения</b>', deadstock.slice(0, 5).map(deadstockLine).join('\n'))
    if (deadstock.length > 5) blocks.push(`…и ещё ${deadstock.length - 5} в Commerce.`)
    blocks.push('Что делать: снизить цену, поставить в акцию или вывезти со склада.')
  }

  // One line, never a list. Ninety-four names would bury the handful that need a decision today.
  if (quietStockouts) {
    blocks.push('', `📦 Ещё ${quietStockouts} товаров с нулевым остатком без продаж за неделю — список в Commerce.`)
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
    .select('id, status, severity, kind, calculation, suggested_action, alerted_at, digest_sent_at, advice_sent_at, commerce_skus!inner(external_sku, title, commerce_catalogs!inner(account_id))')
    .eq('status', 'open').in('commerce_skus.commerce_catalogs.account_id', accountIds).order('created_at', { ascending: false }).limit(500)
  if (error) return json({ error: 'recommendation_lookup_failed' }, 500)
  // Freshness is read here, in the delivery path, rather than in the worker that produces findings.
  // A watchdog hosted by the process it watches goes down with it: if the sync stops, so does every
  // rule that runs inside the sync, and the silence it was meant to report becomes its own silence.
  const { data: freshRows } = await db.rpc('commerce_catalog_freshness', { p_account_ids: accountIds })
  const now = new Date()
  const staleByAccount = new Map<string, CatalogueFreshness[]>()
  const alertedByCatalog = new Map<string, string | null>()
  const catalogsPerAccount = new Map<string, number>()
  const recovered: string[] = []
  for (const row of freshRows ?? []) {
    const accountId = String(row.owner_account_id)
    catalogsPerAccount.set(accountId, (catalogsPerAccount.get(accountId) ?? 0) + 1)
    alertedByCatalog.set(String(row.catalog_id), row.stale_alerted_at ?? null)
    const [stale] = staleCatalogues([row], now)
    if (stale) staleByAccount.set(accountId, [...(staleByAccount.get(accountId) ?? []), stale])
    else if (row.stale_alerted_at) recovered.push(String(row.catalog_id))
  }
  // Clearing happens before any send and regardless of whether Telegram is reachable: it is state
  // hygiene, not a notification. A catalogue that recovers and breaks again must be able to alert
  // a second time, while one continuous outage stays a single alert.
  if (recovered.length) await db.from('commerce_catalogs').update({ stale_alerted_at: null }).in('id', recovered)

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
  let staleSent = 0
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date())
  // Over every pilot account, not only the ones that produced findings. An account whose sync died
  // has no new findings by definition, so the old loop could not reach the one seller who most
  // needed to hear from us — it delivered warnings to everybody except the broken shop.
  for (const accountId of accountIds) {
    const accountRows = byAccount.get(accountId) ?? []
    const stale = staleByAccount.get(accountId) ?? []
    if (!accountRows.length && !stale.length) continue
    if (await blocksExternalActions(db, accountId)) continue
    const target = await telegramTarget(db, accountId)
    if (!target) continue
    const multiShop = (catalogsPerAccount.get(accountId) ?? 0) > 1

    // Замок: истёкшая подписка молчит целиком. Данные при этом никуда не деваются — их видно
    // в интерфейсе; перестаёт работать только то, что Nemo делает САМ.
    const access = await entitlementFor(db, accountId)
    if (!access.allowed) continue

    if (action === 'alerts') {
      // Подключённый магазин без товаров — не авария. Продавец, который ещё не завёл карточки,
      // получает одну вежливую подсказку, а не тревогу: тревога здесь была бы неправдой о том,
      // что случилось, и научила бы отключать уведомления.
      const notice = emptyNotice(stale, { multiShop })
      if (notice && await tgSendHtml(target.token, target.chatId, notice)) {
        await db.from('commerce_catalogs').update({ empty_notified_at: new Date().toISOString() })
          .in('id', stale.filter((item) => item.state === 'empty').map((item) => item.catalogId))
          .is('empty_notified_at', null)
        sent++
      }

      // Once per outage, not once every four hours. The flag is cleared the moment data returns,
      // so a second outage is a second alert and one long outage stays one.
      const broken = brokenCatalogues(stale)
      const unalerted = broken.filter((item) => !alertedByCatalog.get(item.catalogId))
      const warning = staleWarningText(unalerted, { multiShop, allStale: broken.length >= (catalogsPerAccount.get(accountId) ?? 1) })
      if (warning && await tgSendHtml(target.token, target.chatId, warning)) {
        await db.from('commerce_catalogs').update({ stale_alerted_at: new Date().toISOString() })
          .in('id', unalerted.map((item) => item.catalogId)).is('stale_alerted_at', null)
        staleSent++
        sent++
      }
      for (const row of accountRows.filter((item) => item.severity === 'critical' && !item.alerted_at)) {
        if (await tgSendHtml(target.token, target.chatId, criticalText(row))) {
          await db.from('commerce_recommendations').update({ alerted_at: new Date().toISOString() }).eq('id', row.id).is('alerted_at', null)
          sent++
        }
      }
      sent += await sendPriceAdvice(db, target, accountRows)
    } else {
      const unsent = accountRows.filter((item) => item.digest_sent_at !== today)
      const stats = statsByAccount.get(accountId) ?? { skus: 0, approximate: 0 }
      // В дайджесте тоже только аварии: пустой магазин один раз упомянут в алертах и больше не
      // занимает место в утренней сводке, где каждая строка должна требовать решения.
      const brokenForDigest = brokenCatalogues(stale)
      const warning = staleWarningText(brokenForDigest, { multiShop, allStale: brokenForDigest.length >= (catalogsPerAccount.get(accountId) ?? 1) })
      if (!unsent.length && !warning) continue
      // The warning leads, and the digest is sent even when there is nothing new to report —
      // silence was the bug. Everything under the warning was computed from data that stopped
      // arriving, and the seller has to know that before reading a single number.
      // Совет по цене уходит ОТДЕЛЬНЫМ сообщением с кнопками. В сводке он остался бы строкой,
      // а строку нельзя нажать: между «маржа ниже минимума» и решением стояла бы вкладка в
      // браузере, до которой владелец дойдёт вечером или не дойдёт.
      sent += await sendPriceAdvice(db, target, accountRows)
      const text = [warning, unsent.length ? digestText(unsent, stats) : null].filter(Boolean).join('\n\n')
      if (await tgSendHtml(target.token, target.chatId, text)) {
        if (unsent.length) {
          await db.from('commerce_recommendations').update({ digest_sent_at: today }).in('id', unsent.map((item) => item.id))
        }
        sent++
        if (warning) staleSent++
      }
    }
  }
  return json({ ok: true, action, sent, stale_sent: staleSent })
})
