// Official Uzum Seller API, read-only executor.
// The token is supplied by the account's encrypted provider_keys row and is
// deliberately never returned, logged, or placed in an LLM prompt.

const BASE_URL = 'https://api-seller.uzum.uz/api/seller-openapi'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function request(path: string, token: string, attempt = 0): Promise<{ ok: boolean; data: Json; status: number }> {
  try {
    // Uzum's official OpenAPI specifies a raw token in Authorization — no Bearer prefix.
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: token, Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    })
    // Uzum rate-limits per key (it returns x-ratelimit-* headers). One shop hitting 429 must not
    // erase the whole store report, so wait and try once more before giving up on it.
    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      return await request(path, token, 1)
    }
    const data = await response.json().catch(() => ({}))
    return { ok: response.ok, data, status: response.status }
  } catch {
    return { ok: false, data: {}, status: 0 }
  }
}

/**
 * "This key cannot see this shop" is a fact about permissions, not a malfunction. A seller who
 * granted the key access to 2 of their 4 shops should be told exactly that — reporting it as an
 * error makes a correctly-scoped key look broken.
 */
export type ShopAccess = 'ok' | 'no_access' | 'rate_limited' | 'error'

function classify(status: number, message: string): ShopAccess {
  if (status === 401 || status === 403) return 'no_access'
  if (/not available|нет доступа|no access|forbidden|not found/i.test(message)) return 'no_access'
  if (status === 429 || /rate.?limit|too many/i.test(message)) return 'rate_limited'
  return 'error'
}

function errorMessage(data: Json, status: number): string {
  const detail = String(data?.message ?? data?.error?.message ?? data?.error ?? '').replace(/[\r\n]/g, ' ').slice(0, 140)
  return detail || (status ? `HTTP ${status}` : 'сеть недоступна')
}

function listOf(data: Json): Json[] {
  const candidate = data?.data ?? data?.result ?? data?.items ?? data?.content ?? data
  if (Array.isArray(candidate)) return candidate
  // Current Uzum OpenAPI response containers:
  // - AllProducts.productList
  // - SellerOrdersDto.orders
  // Keep the older aliases for backwards compatibility with previously observed responses.
  for (const key of ['shops', 'productList', 'orders', 'orderItems', 'products', 'rows', 'list']) {
    if (Array.isArray(candidate?.[key])) return candidate[key]
  }
  return []
}

// Field names differ between Uzum API versions and between list/detail responses, so every
// value is resolved through candidate keys and the resolver REPORTS which key it matched.
// Guessing one name and silently returning nothing is the failure mode this avoids: an empty
// number that looks like a real one is worse than an honest "not available".
function pick(row: Json, candidates: string[]): { value: Json; key: string } | null {
  for (const key of candidates) {
    const value = row?.[key]
    if (value !== undefined && value !== null && value !== '') return { value, key }
  }
  return null
}
const num = (value: Json): number | null => {
  const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

export interface UzumShop { id: string; name: string }
export interface UzumProductRow {
  sku: string
  productId: string
  name: string
  price: number | null
  stock: number | null
  stockFbo: number | null
  stockFbs: number | null
}

/** Structured store list. Unlike the smoke wrapper, this returns the numeric ids callers need. */
export async function uzumShopList(token: string): Promise<{ ok: boolean; shops: UzumShop[]; error?: string }> {
  const response = await request('/v1/shops', token)
  if (!response.ok) return { ok: false, shops: [], error: errorMessage(response.data, response.status) }
  const shops = listOf(response.data)
    .map((shop: Json) => ({
      id: String(pick(shop, ['id', 'shopId', 'shop_id'])?.value ?? '').trim(),
      name: String(pick(shop, ['name', 'title', 'shopName'])?.value ?? 'магазин').slice(0, 120),
    }))
    .filter((shop: UzumShop) => /^\d{1,18}$/.test(shop.id))
  return { ok: true, shops }
}

const ACCESS_LABEL: Record<ShopAccess, string> = {
  ok: 'доступен',
  no_access: 'ключ не даёт доступа к этому магазину',
  rate_limited: 'Uzum временно ограничил запросы — данные можно получить позже',
  error: 'ошибка запроса',
}

/**
 * Lists the stores and, for each, whether this key can actually read it. The seller owns four
 * shops and granted the key two: the answer must say which two, not present the other two as
 * failures of the product.
 */
export async function uzumShops(token: string): Promise<{ ok: boolean; result: string }> {
  const report = await uzumStoreReport(token, 1)
  if (!report.ok) return { ok: false, result: `Uzum не принял ключ (${report.error}).` }
  if (!report.shops.length) return { ok: true, result: 'Uzum подключён, но ключ не видит ни одного магазина.' }

  const open = report.shops.filter((s) => s.access === 'ok')
  const closed = report.shops.filter((s) => s.access === 'no_access')
  const busy = report.shops.filter((s) => s.access === 'rate_limited')
  const broken = report.shops.filter((s) => s.access === 'error')

  const lines = [
    `Магазинов у продавца: ${report.shops.length}. Ключ читает: ${open.length}.`,
    ...open.map((s) => `• ${s.shop.name} (ID ${s.shop.id}) — ${ACCESS_LABEL.ok}`),
    ...closed.map((s) => `• ${s.shop.name} (ID ${s.shop.id}) — ${ACCESS_LABEL.no_access}`),
    ...busy.map((s) => `• ${s.shop.name} (ID ${s.shop.id}) — ${ACCESS_LABEL.rate_limited}`),
    ...broken.map((s) => `• ${s.shop.name} (ID ${s.shop.id}) — ${ACCESS_LABEL.error}: ${s.error ?? ''}`),
  ]
  if (closed.length) {
    lines.push(`Это ограничение ключа, а не сбой: чтобы Nemo видел ${closed.length} остальных, выдайте ключу доступ к ним в кабинете Uzum Seller.`)
  }
  return { ok: true, result: lines.join('\n') }
}

const PRICE_KEYS = ['price', 'sellPrice', 'sellerPrice', 'currentPrice', 'fullPrice', 'salePrice', 'retailPrice']
const STOCK_KEYS = ['stock', 'quantity', 'amount', 'available', 'availableAmount', 'remains', 'qty', 'inStock', 'count']

/**
 * Structured product rows for one shop, plus an honest account of which fields the API actually
 * returned. `missing` is what callers must NOT invent: no price means no margin, no stock means
 * no reorder quantity.
 */
export async function uzumProductRows(
  token: string,
  shopId: string,
  limit = 200,
): Promise<{ ok: boolean; rows: UzumProductRow[]; missing: string[]; access?: ShopAccess; error?: string }> {
  const id = String(shopId).trim()
  if (!/^\d{1,18}$/.test(id)) return { ok: false, rows: [], missing: [], access: 'error', error: 'нужен числовой ID магазина' }
  // `size` and `page` are required by Uzum's OpenAPI. A one-page read was the reason a shop with
  // more products appeared to have only a few SKUs. Fetch up to 200 product cards, in pages of
  // 50, so the boundary is explicit and never mistaken for the whole catalogue.
  const wanted = Math.min(Math.max(limit, 1), 200)
  const size = Math.min(wanted, 50)
  const products: Json[] = []
  for (let page = 0; products.length < wanted; page++) {
    const response = await request(`/v1/product/shop/${encodeURIComponent(id)}?size=${size}&page=${page}`, token)
    if (!response.ok) {
      const message = errorMessage(response.data, response.status)
      return { ok: false, rows: [], missing: [], access: classify(response.status, message), error: message }
    }
    const batch = listOf(response.data)
    products.push(...batch)
    // Short page means the API has no further product cards. If it exactly fills the page we
    // request one more page; that avoids treating an exact multiple of 50 as the end.
    if (batch.length < size) break
  }
  // AllProducts contains product cards, while price and stock live on each card's skuList.
  // Flatten those variants so the agent receives real sellable SKUs instead of an empty catalogue.
  const rows: UzumProductRow[] = products.flatMap((product: Json) => {
    const skuList = Array.isArray(product?.skuList) ? product.skuList : []
    const variants = skuList.length ? skuList : [product]
    return variants.map((sku: Json) => {
      const fbo = num(pick(sku, ['quantityActive'])?.value)
      const fbs = num(pick(sku, ['quantityFbs'])?.value)
      const fallbackStock = (() => { const found = pick(sku, STOCK_KEYS); return found ? num(found.value) : null })()
      return {
        sku: String(pick(sku, ['sellerItemCode', 'article', 'skuId', 'skuTitle', 'barcode'])?.value ?? '').slice(0, 60),
        productId: String(pick(product, ['productId', 'id'])?.value ?? '').slice(0, 60),
        name: String(pick(sku, ['skuFullTitle', 'productTitle', 'skuTitle'])?.value
          ?? pick(product, ['title', 'skuTitle'])?.value
          ?? 'без названия').slice(0, 120),
        price: (() => { const found = pick(sku, PRICE_KEYS); return found ? num(found.value) : null })(),
        stock: fbo != null || fbs != null ? (fbo ?? 0) + (fbs ?? 0) : fallbackStock,
        stockFbo: fbo,
        stockFbs: fbs,
      }
    })
  }).slice(0, wanted)
  const missing: string[] = []
  if (rows.length && rows.every((row) => row.price == null)) missing.push('цена')
  if (rows.length && rows.every((row) => row.stock == null)) missing.push('остаток')
  return { ok: true, rows, missing, access: 'ok' }
}

export interface ShopReport {
  shop: UzumShop
  access: ShopAccess
  rows: UzumProductRow[]
  missing: string[]
  error?: string
}

/**
 * Every shop the key can list, each with its own verdict. A seller with four shops who granted the
 * key access to two must see exactly that split — which two answer, and why the others do not.
 */
export async function uzumStoreReport(token: string, limit = 200): Promise<{ ok: boolean; shops: ShopReport[]; error?: string }> {
  const listed = await uzumShopList(token)
  if (!listed.ok) return { ok: false, shops: [], error: listed.error }
  const reports: ShopReport[] = []
  for (const shop of listed.shops) {
    const fetched = await uzumProductRows(token, shop.id, limit)
    reports.push({
      shop,
      access: fetched.access ?? (fetched.ok ? 'ok' : 'error'),
      rows: fetched.rows,
      missing: fetched.missing,
      ...(fetched.error ? { error: fetched.error } : {}),
    })
  }
  return { ok: true, shops: reports }
}

export interface UzumSales {
  ok: boolean
  days: number
  orders: number
  revenue: number | null
  unitsBySku: Record<string, number>
  namesBySku: Record<string, string>
  error?: string
}

/**
 * Units sold per product over the last N days, from GET /v1/finance/orders.
 *
 * This is the seller's finance sales feed, not the FBS operations queue, so it is the safe source
 * for a whole-store catalogue audit. Its items carry `productId`, `skuTitle`, `productTitle`,
 * `amount`, `amountReturns` and `cancelled`.
 *
 * Returned and cancelled units are removed from the amount. Per-SKU revenue is deliberately not
 * derived because the finance item fields do not state whether a price is per-unit or line total.
 */
export async function uzumSalesRows(token: string, shopId: string, days = 7, maxPages = 5): Promise<UzumSales> {
  const id = String(shopId).trim()
  const empty: UzumSales = { ok: false, days, orders: 0, revenue: null, unitsBySku: {}, namesBySku: {} }
  if (!/^\d{1,18}$/.test(id)) return { ...empty, error: 'нужен числовой ID магазина' }
  const to = Date.now()
  const from = to - days * 86_400_000
  const unitsBySku: Record<string, number> = {}
  const namesBySku: Record<string, string> = {}
  const orderIds = new Set<string>()

  for (let page = 0; page < maxPages; page++) {
    const query = `shopIds=${encodeURIComponent(id)}&dateFrom=${from}&dateTo=${to}&page=${page}&size=50&group=false`
    const response = await request(`/v1/finance/orders?${query}`, token)
    if (!response.ok) return { ...empty, error: errorMessage(response.data, response.status) }
    const batch = listOf(response.data)
    if (!batch.length) break
    for (const item of batch) {
      const sku = String(pick(item, ['productId', 'skuTitle', 'id'])?.value ?? '').trim()
      if (!sku) continue
      const amount = num(pick(item, ['amount'])?.value) ?? 0
      const returned = num(pick(item, ['amountReturns'])?.value) ?? 0
      const cancelled = num(pick(item, ['cancelled'])?.value) ?? 0
      const netUnits = Math.max(0, amount - returned - cancelled)
      unitsBySku[sku] = (unitsBySku[sku] ?? 0) + netUnits
      const orderId = String(pick(item, ['orderId'])?.value ?? '').trim()
      if (orderId) orderIds.add(orderId)
      const name = String(pick(item, ['productTitle', 'skuTitle'])?.value ?? '').slice(0, 120)
      if (name && !namesBySku[sku]) namesBySku[sku] = name
    }
    if (batch.length < 50) break
  }
  return { ok: true, days, orders: orderIds.size, revenue: null, unitsBySku, namesBySku }
}

/** Read product/SKU metadata for an explicitly selected seller shop. No mutations. */
export async function uzumProducts(token: string, shopId: string, limit = 30): Promise<{ ok: boolean; result: string }> {
  const fetched = await uzumProductRows(token, shopId, limit)
  if (!fetched.ok) {
    const label = ACCESS_LABEL[fetched.access ?? 'error']
    // Separate "you were not given access" from "something went wrong", so the agent reports a
    // permission boundary as a boundary instead of describing the store as broken.
    return {
      ok: false,
      result: fetched.access === 'no_access'
        ? `Магазин ${shopId}: ${label}. Выдайте ключу доступ к нему в кабинете Uzum Seller — со стороны Nemo всё исправно.`
        : `Магазин ${shopId}: ${label} (${fetched.error}).`,
    }
  }
  if (!fetched.rows.length) return { ok: true, result: 'Uzum подключён, но товары для этого магазина не найдены.' }
  const lines = fetched.rows.map((row) => {
    const parts = [`• ${row.name}`]
    if (row.sku) parts.push(`SKU ${row.sku}`)
    if (row.price != null) parts.push(`цена ${row.price}`)
    if (row.stock != null) parts.push(`остаток ${row.stock}`)
    return parts.join(' — ')
  })
  const caveat = fetched.missing.length
    ? `\nUzum не вернул: ${fetched.missing.join(', ')}. Эти величины неизвестны — не оценивай их.`
    : ''
  return { ok: true, result: `Товары Uzum (показано ${fetched.rows.length}):\n${lines.join('\n')}${caveat}` }
}
