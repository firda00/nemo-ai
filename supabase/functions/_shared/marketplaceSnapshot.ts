// Live store snapshot for autonomous team runs.
//
// Until now `orchestrate` imported no tool executor at all: a team asked "how is my shop doing"
// produced four specialists writing plans about data they could never reach, and the run ended in
// a checklist. The account's Uzum key was connected the whole time.
//
// This fetches the store once per run and hands the team FACTS, with an explicit account of what
// the API did not return. The block is written so a model cannot mistake an absent field for a
// zero: what is missing is named, and inventing it is forbidden in the same breath.

import { uzumSalesRows, uzumShopList, uzumStoreReport } from './uzum.ts'
import { openSecret, providerSecretContext } from './secretBox.ts'
import { marketplaceEvidenceBlock } from './marketplaceData.ts'
import { growthPlan, growthPlanBlock } from './growthPlan.ts'
import { catalogAuditBlock, catalogAuditOwnerReport, catalogueOwnerReport } from './catalogAudit.ts'

export interface StoreSnapshot {
  connected: boolean
  provider: string | null
  block: string
  rowCount: number
  missing: string[]
  auditReport: string
  catalogueReport: string
}

const EMPTY: StoreSnapshot = { connected: false, provider: null, block: '', rowCount: 0, missing: [], auditReport: '', catalogueReport: '' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function storeSnapshot(db: any, accountId: string, maxRows = 200): Promise<StoreSnapshot> {
  const { data: keyRow } = await db
    .from('provider_keys')
    .select('provider, api_key')
    .eq('account_id', accountId)
    .eq('provider', 'uzum')
    .maybeSingle()
  if (!keyRow?.api_key) return EMPTY

  let token = ''
  try {
    token = await openSecret(keyRow.api_key, providerSecretContext(accountId, 'uzum'))
  } catch {
    return EMPTY
  }
  if (!token) return EMPTY

  const listed = await uzumShopList(token)
  if (!listed.ok || !listed.shops.length) {
    // A connected key that cannot list shops is a real state the team must know about — silence
    // here would look identical to "no integration", which is what made the old flow confusing.
    return {
      connected: true,
      provider: 'uzum',
      rowCount: 0,
      missing: ['список магазинов'],
      auditReport: '',
      catalogueReport: '',
      block: [
        '=== ПОДКЛЮЧЁННЫЙ МАГАЗИН: UZUM ===',
        listed.ok
          ? 'Ключ принят, но магазинов не вернулось. Данных о товарах нет.'
          : `Uzum не ответил на запрос магазинов: ${listed.error ?? 'неизвестная ошибка'}.`,
        'НЕ придумывай товары, цены, остатки или продажи. Скажи владельцу, что нужно проверить ключ Uzum.',
        '=== КОНЕЦ ===',
      ].join('\n'),
    }
  }

  // A seller can own several shops and grant the key only some of them. Read every shop the key
  // can actually open, and state the split — treating "not granted" as a failure would tell the
  // owner their store is broken when their key is simply scoped.
  const report = await uzumStoreReport(token, maxRows)
  const open = report.shops.filter((s) => s.access === 'ok')
  const closed = report.shops.filter((s) => s.access !== 'ok')
  const accessNote = [
    `Магазинов у продавца: ${report.shops.length}. Ключ читает: ${open.length}.`,
    ...open.map((s) => `• ${s.shop.name} (ID ${s.shop.id}) — данные получены`),
    ...closed.map((s) => `• ${s.shop.name} (ID ${s.shop.id}) — данных нет: ${s.access === 'no_access' ? 'ключу не выдан доступ' : s.access === 'rate_limited' ? 'Uzum ограничил запросы' : s.error ?? 'ошибка'}`),
  ].join('\n')

  if (!open.length) {
    return {
      connected: true,
      provider: 'uzum',
      rowCount: 0,
      missing: ['товары'],
      auditReport: '',
      catalogueReport: '',
      block: [
        '=== ПОДКЛЮЧЁННЫЙ МАГАЗИН: UZUM ===',
        accessNote,
        'Ни по одному магазину данных нет. НЕ придумывай ассортимент и числа — скажи владельцу,',
        'каким магазинам нужно выдать доступ ключу в кабинете Uzum Seller.',
        '=== КОНЕЦ ===',
      ].join('\n'),
    }
  }

  const fetched = {
    ok: true,
    rows: open.flatMap((s) => s.rows),
    missing: [...new Set(open.flatMap((s) => s.missing))],
  }

  // Sales for exactly seven days, so the canonical `sales_7d` header below is literally true and
  // the deterministic calculator can consume it without a unit assumption.
  // Each accessible shop has its own FBS order feed. Reading only the first shop made a
  // multi-shop audit classify the other shops from missing data, which is neither useful nor fair.
  const salesByShop = await Promise.all(open.map(async (entry) => ({
    shopId: entry.shop.id,
    sales: await uzumSalesRows(token, entry.shop.id, 7),
  })))
  const sumNumberRecords = (records: Array<Record<string, number>>) => records.reduce<Record<string, number>>((out, record) => {
    for (const [key, value] of Object.entries(record)) out[key] = (out[key] ?? 0) + value
    return out
  }, {})
  const sales = {
    ok: salesByShop.some((entry) => entry.sales.ok),
    orders: salesByShop.reduce((sum, entry) => sum + (entry.sales.ok ? entry.sales.orders : 0), 0),
    revenue: salesByShop.every((entry) => entry.sales.ok && entry.sales.revenue != null)
      ? salesByShop.reduce((sum, entry) => sum + (entry.sales.revenue ?? 0), 0)
      : null,
    unitsBySku: sumNumberRecords(salesByShop.filter((entry) => entry.sales.ok).map((entry) => entry.sales.unitsBySku)),
    namesBySku: Object.assign({}, ...salesByShop.filter((entry) => entry.sales.ok).map((entry) => entry.sales.namesBySku)),
    error: salesByShop.filter((entry) => !entry.sales.ok).map((entry) => `${entry.shopId}: ${entry.sales.error ?? 'ошибка запроса'}`).join('; '),
  }
  const productIdCount = fetched.rows.reduce<Record<string, number>>((counts, row) => {
    if (row.productId) counts[row.productId] = (counts[row.productId] ?? 0) + 1
    return counts
  }, {})
  const nameCount = fetched.rows.reduce<Record<string, number>>((counts, row) => {
    if (row.name) counts[row.name] = (counts[row.name] ?? 0) + 1
    return counts
  }, {})
  const unitsFor = (row: { sku: string; productId: string; name: string }): number | null => {
    if (!sales.ok) return null
    // Order items carry a barcode / skuId / skuTitle; catalogue rows carry their own sku. Match on
    // whichever key both sides agree on, and leave it unknown rather than assuming zero sales.
    const direct = sales.unitsBySku[row.sku]
    if (direct != null) return direct
    // SellerProductCard.productId is the documented identifier that also appears on FBS order
    // items. It is usable only for a single catalogue row: otherwise assigning product-level
    // sales to every colour/size variant would inflate the report.
    if (row.productId && productIdCount[row.productId] === 1 && sales.unitsBySku[row.productId] != null) {
      return sales.unitsBySku[row.productId]
    }
    const byName = nameCount[row.name] === 1 && Object.entries(sales.namesBySku).find(([, name]) => name && name === row.name)
    return byName ? sales.unitsBySku[byName[0]] ?? null : null
  }

  const priced = fetched.rows.map((row) => ({ ...row, units: unitsFor(row) }))
  const matched = priced.filter((row) => row.units != null).length
  // Cost, fees, returns and lead time are still not obtainable from any implemented endpoint.
  const unavailable = ['себестоимость', 'комиссии', 'возвраты', 'срок поставки', 'отзывы и комментарии', ...fetched.missing]
  if (!sales.ok) unavailable.unshift('продажи за период')

  // Canonical header -> the same server-side calculator that verifies an uploaded file now runs on
  // live store data, so reorder quantities and coverage are computed, never generated.
  const table = ['sku,sales_7d,stock,price', ...priced
    .filter((row) => row.sku && row.units != null && row.stock != null)
    .map((row) => [row.sku, row.units, row.stock, row.price ?? ''].join(','))].join('\n')
  const calculated = table.includes('\n') ? marketplaceEvidenceBlock(table) : ''

  // A growth target is arithmetic, not a promise: how many extra units it means, how many are
  // recoverable from demand already being lost, and how large the part that needs new demand is.
  const growth = growthPlanBlock(growthPlan(priced, 20, 7))
  const audit = catalogAuditBlock(priced, 7)

  const catalogue = [
    'sku,название,цена,остаток,продано_за_7д',
    ...priced.map((row) => [row.sku || '-', row.name.replace(/,/g, ' '), row.price ?? '', row.stock ?? '', row.units ?? ''].join(',')),
  ]

  return {
    connected: true,
    provider: 'uzum',
    rowCount: fetched.rows.length,
    missing: unavailable,
    auditReport: catalogAuditOwnerReport(priced, 7),
    catalogueReport: catalogueOwnerReport(priced, 7),
    block: [
      '=== ПОДКЛЮЧЁННЫЙ МАГАЗИН: UZUM (данные получены сервером, не выдуманы) ===',
      accessNote,
      `Товаров получено суммарно: ${fetched.rows.length}.`,
      sales.ok
        ? `Заказов за 7 дней: ${sales.orders}${sales.revenue != null ? `, выручка ${sales.revenue}` : ''}. Продажи сопоставлены для ${matched} из ${fetched.rows.length} позиций.`
        : `Продажи получить не удалось: ${sales.error ?? 'ошибка запроса'}. Числа о продажах отсутствуют.`,
      ...catalogue,
      '',
      `Uzum НЕ отдаёт: ${unavailable.join(', ')}.`,
      'Пустая клетка означает «неизвестно», а не ноль. Не оценивай отсутствующие величины и не выводи',
      'из них маржу, план закупки или бюджет: без себестоимости и комиссий прибыль посчитать нельзя —',
      'скажи об этом прямо и назови, каких данных не хватает.',
      calculated,
      growth,
      audit,
      '=== КОНЕЦ ДАННЫХ МАГАЗИНА ===',
    ].filter(Boolean).join('\n'),
  }
}
