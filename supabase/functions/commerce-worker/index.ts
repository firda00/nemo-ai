// Read-only Uzum catalogue synchronizer. Invoked only by pg_cron or a service-role dispatch.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { json } from '../_shared/cors.ts'
import { uzumProductRows, uzumSalesRows, type UzumProductRow } from '../_shared/uzum.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'
import { batchOutcome, marginPercent as marginFor, minSellingPriceTiyin, netProfitTiyin } from '../_shared/unitEconomics.ts'
import { fulfillmentTiyin } from '../_shared/uzumLogistics.ts'
import { reservesForCatalogue } from '../_shared/returnsReserve.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? ''
const MAX_RUNS = 20

type Any = Record<string, any>
type SyncRun = { id: string; catalog_id: string; scheduled_for: string; claim_token: string }
type Catalog = { id: string; account_id: string; external_shop_id: string; status: string }
type Sku = {
  id: string
  external_sku: string
  external_product_id: string | null
  title: string
  unit_cost_tiyin: number | null
  commission_percent: number | null
  fulfillment_tiyin: number | null
  returns_reserve_percent: number | null
  lead_time_days: number | null
  moq: number | null
  safety_stock: number | null
  min_margin_percent: number | null
  estimated_fields: string[] | null
  economics_revision: number
}

const nonNegativeInteger = (value: number | null): number | null =>
  value != null && Number.isFinite(value) && value >= 0 ? Math.round(value) : null

function salesFor(row: UzumProductRow, sales: Any, productIdCounts: Record<string, number>, titleCounts: Record<string, number>): number | null {
  if (!sales.ok) return null
  if (sales.unitsBySku[row.sku] != null) return nonNegativeInteger(sales.unitsBySku[row.sku])
  if (row.productId && productIdCounts[row.productId] === 1 && sales.unitsBySku[row.productId] != null) {
    return nonNegativeInteger(sales.unitsBySku[row.productId])
  }
  if (row.name && titleCounts[row.name] === 1) {
    const key = Object.keys(sales.namesBySku).find((candidate) => sales.namesBySku[candidate] === row.name)
    if (key && sales.unitsBySku[key] != null) return nonNegativeInteger(sales.unitsBySku[key])
  }
  return 0
}

function recommendation(sku: Sku, snapshotId: string, priceTiyin: number | null, stock: number | null, sold7d: number | null, historyReady: boolean): Any[] {
  const missing = [
    stock == null && 'stock_total',
    priceTiyin == null && 'price_tiyin',
    sold7d == null && 'sold_units_7d',
    sku.lead_time_days == null && 'lead_time_days',
    sku.safety_stock == null && 'safety_stock',
    sku.unit_cost_tiyin == null && 'unit_cost_tiyin',
    sku.commission_percent == null && 'commission_percent',
    sku.fulfillment_tiyin == null && 'fulfillment_tiyin',
    sku.returns_reserve_percent == null && 'returns_reserve_percent',
    sku.min_margin_percent == null && 'min_margin_percent',
  ].filter(Boolean) as string[]
  const base = { sku_id: sku.id, snapshot_id: snapshotId, economics_revision: sku.economics_revision }
  const rows: Any[] = []
  const estimated = Array.isArray(sku.estimated_fields) ? sku.estimated_fields : []
  // An owner-estimated input can never raise a critical alert: guessed economics must not
  // wake anyone at night or imply a confirmed loss. Estimates only ever warn.
  const severityFor = (critical: boolean, inputs: string[]): 'critical' | 'warning' => {
    const guessed = inputs.filter((field) => estimated.includes(field))
    return critical && !guessed.length ? 'critical' : 'warning'
  }
  const estimatesUsed = (inputs: string[]) => inputs.filter((field) => estimated.includes(field))

  if (missing.length) rows.push({
    ...base, kind: 'missing_data', severity: 'warning', dedupe_key: `commerce:${sku.id}:missing_data`,
    calculation: { missing }, suggested_action: { type: 'supply_fields', fields: missing }, last_detected_at: new Date().toISOString(),
  })

  if (!historyReady) missing.push('seven_full_days_of_history')

  if (historyReady && stock != null && sold7d != null && sku.lead_time_days != null && sku.safety_stock != null) {
    const dailyVelocity = sold7d / 7
    const reorderPoint = Math.ceil(dailyVelocity * sku.lead_time_days) + sku.safety_stock
    const targetUnits = Math.ceil(dailyVelocity * (sku.lead_time_days + 7)) + sku.safety_stock
    const rawUnits = Math.max(0, targetUnits - stock)
    const units = sku.moq ? Math.ceil(rawUnits / sku.moq) * sku.moq : rawUnits
    const reorderInputs = ['lead_time_days', 'safety_stock', 'moq']
    // What the reorder is worth, when the economics to answer that exist. "Order 150 units"
    // is a logistics instruction; "150 units, 12.75M in, 4.69M out" is a decision the owner
    // can actually weigh against other uses of the same cash.
    const canValue = priceTiyin != null && priceTiyin > 0 && sku.unit_cost_tiyin != null
      && sku.commission_percent != null && sku.returns_reserve_percent != null && sku.fulfillment_tiyin != null
    const outcome = canValue
      ? batchOutcome(units, priceTiyin!, sku.unit_cost_tiyin!, {
        commission_percent: sku.commission_percent!,
        returns_reserve_percent: sku.returns_reserve_percent!,
        fulfillment_tiyin: sku.fulfillment_tiyin!,
      })
      : null
    const valueInputs = [...reorderInputs, 'unit_cost_tiyin', 'commission_percent', 'returns_reserve_percent', 'fulfillment_tiyin']
    if (dailyVelocity > 0 && stock <= reorderPoint) rows.push({
      ...base, kind: 'reorder', severity: severityFor(stock / dailyVelocity <= sku.lead_time_days, reorderInputs),
      dedupe_key: `commerce:${sku.id}:reorder`,
      calculation: { sold_units_7d: sold7d, daily_velocity: dailyVelocity, stock_total: stock, lead_time_days: sku.lead_time_days, safety_stock: sku.safety_stock, reorder_point: reorderPoint, target_units: targetUnits, reorder_units: units, batch: outcome, estimated_inputs: estimatesUsed(outcome ? valueInputs : reorderInputs) },
      suggested_action: { type: 'review_reorder', units, investment_tiyin: outcome?.investment_tiyin ?? null, profit_tiyin: outcome?.profit_tiyin ?? null, roi_percent: outcome?.roi_percent ?? null }, last_detected_at: new Date().toISOString(),
    })
  }

  if (priceTiyin != null && sku.unit_cost_tiyin != null && sku.commission_percent != null && sku.fulfillment_tiyin != null && sku.returns_reserve_percent != null && sku.min_margin_percent != null && priceTiyin > 0) {
    // One definition of margin for the whole platform, shared with the calculators. Two copies
    // of this algebra eventually disagree, and the seller is the one who meets the conflict.
    const fees = { commission_percent: sku.commission_percent, returns_reserve_percent: sku.returns_reserve_percent, fulfillment_tiyin: sku.fulfillment_tiyin }
    const net = netProfitTiyin(priceTiyin, sku.unit_cost_tiyin, fees)
    const marginPercent = marginFor(priceTiyin, sku.unit_cost_tiyin, fees) ?? 0
    const floorTiyin = minSellingPriceTiyin(sku.unit_cost_tiyin, sku.min_margin_percent, fees)
    const priceInputs = ['unit_cost_tiyin', 'fulfillment_tiyin', 'commission_percent', 'returns_reserve_percent', 'min_margin_percent']
    if (marginPercent < sku.min_margin_percent) rows.push({
      ...base, kind: 'price_guard', severity: severityFor(marginPercent <= 0, priceInputs), dedupe_key: `commerce:${sku.id}:price_guard`,
      calculation: { price_tiyin: priceTiyin, unit_cost_tiyin: sku.unit_cost_tiyin, fulfillment_tiyin: sku.fulfillment_tiyin, commission_percent: sku.commission_percent, returns_reserve_percent: sku.returns_reserve_percent, margin_percent: marginPercent, net_profit_tiyin: Math.round(net), min_margin_percent: sku.min_margin_percent, min_selling_price_tiyin: floorTiyin, estimated_inputs: estimatesUsed(priceInputs) },
      suggested_action: { type: 'review_price', minimum_margin_percent: sku.min_margin_percent, min_selling_price_tiyin: floorTiyin }, last_detected_at: new Date().toISOString(),
    })
  }
  return rows
}

async function finish(db: any, run: SyncRun, status: 'completed' | 'failed' | 'skipped', error: string | null = null): Promise<boolean> {
  const { data, error: updateError } = await db.from('commerce_sync_runs')
    .update({ status, error, completed_at: new Date().toISOString() })
    .eq('id', run.id).eq('claim_token', run.claim_token).eq('status', 'running').select('id')
  if (updateError) throw updateError
  return Boolean(data?.length)
}

async function processRun(db: any, run: SyncRun): Promise<'completed' | 'failed' | 'skipped'> {
  const { data: catalog, error: catalogError } = await db.from('commerce_catalogs')
    .select('id, account_id, external_shop_id, status').eq('id', run.catalog_id).maybeSingle()
  if (catalogError) throw catalogError
  if (!catalog || catalog.status !== 'active') {
    if (!await finish(db, run, 'skipped', 'catalog is not active')) throw new Error('claim lost')
    return 'skipped'
  }
  const typedCatalog = catalog as Catalog
  const { data: pilot, error: pilotError } = await db.from('commerce_pilots')
    .select('account_id').eq('account_id', typedCatalog.account_id).eq('status', 'active').gt('expires_at', new Date().toISOString()).maybeSingle()
  if (pilotError) throw pilotError
  if (!pilot) {
    if (!await finish(db, run, 'skipped', 'commerce pilot is inactive or expired')) throw new Error('claim lost')
    return 'skipped'
  }
  const { data: keyRow, error: keyError } = await db.from('provider_keys')
    .select('api_key').eq('account_id', typedCatalog.account_id).eq('provider', 'uzum').maybeSingle()
  if (keyError) throw keyError
  if (!keyRow?.api_key) {
    if (!await finish(db, run, 'skipped', 'Uzum provider key is not connected')) throw new Error('claim lost')
    return 'skipped'
  }
  const token = await openSecret(keyRow.api_key, providerSecretContext(typedCatalog.account_id, 'uzum'))
  if (!token) {
    if (!await finish(db, run, 'skipped', 'Uzum provider key is empty')) throw new Error('claim lost')
    return 'skipped'
  }

  const [products, sales] = await Promise.all([
    uzumProductRows(token, typedCatalog.external_shop_id, 200),
    uzumSalesRows(token, typedCatalog.external_shop_id, 7),
  ])
  if (!products.ok) {
    // Record the reason on the catalogue, not only on the run. Without this a shop the key
    // cannot read stays "active" with an empty error in the UI, and the owner has no way to
    // learn that two of their four shops never sync.
    // Keep the HTTP status: 401/403 means the key is not scoped to this shop, while a 4xx with
    // a body message can mean the shop itself is not open. Without it the two are guesswork.
    const reason = `${products.error ?? 'Uzum product read failed'}${products.status ? ` (HTTP ${products.status})` : ''}`
    // Status deliberately stays 'active'. Both the queue and the claim RPC select only active
    // catalogues, so flipping it to no_access would drop the shop out of sync permanently —
    // and it would stay dropped after the owner granted access in Uzum. Leaving it active
    // costs six failed calls a day and lets the shop heal itself the moment access appears.
    await db.from('commerce_catalogs').update({
      last_sync_error: products.access === 'no_access'
        ? `${reason} — выдайте ключу доступ к этому магазину в кабинете Uzum Seller`
        : reason,
    }).eq('id', typedCatalog.id)
    throw new Error(reason)
  }
  const productRows = [...new Map(products.rows.filter((row) => row.sku).map((row) => [row.sku, row])).values()]
  let skuRows: Sku[] = []
  if (productRows.length) {
    const { data, error: skuError } = await db.from('commerce_skus').upsert(productRows.map((row) => ({
      catalog_id: typedCatalog.id, external_sku: row.sku, external_product_id: row.productId || null, title: row.name || 'Unnamed Uzum SKU',
    })), { onConflict: 'catalog_id,external_sku' }).select('id, external_sku, external_product_id, title, unit_cost_tiyin, commission_percent, fulfillment_tiyin, returns_reserve_percent, lead_time_days, moq, safety_stock, min_margin_percent, estimated_fields, economics_revision')
    if (skuError) throw skuError
    skuRows = (data ?? []) as Sku[]
  }
  const skuByExternal = new Map(skuRows.map((sku) => [sku.external_sku, sku]))

  // Uzum's own facts land before the recommendations are computed, so this run already reasons
  // with the real commission and the fee derived from real dimensions instead of estimates.
  // The RPC decides what may be written: it never touches a value the owner set themselves.
  // One call for the whole catalogue: a per-SKU round trip took 140 of them for a single shop
  // and exceeded the function's 150-second limit.
  // The reserve needs the whole catalogue at once: a SKU with six sales is estimated from its
  // category, and the category from the catalogue. Computed before the loop for that reason.
  const reserves = reservesForCatalogue(productRows.map((row) => ({
    key: row.sku,
    category: row.category,
    observation: { sold: row.soldUnits, returned: row.returnedUnits },
  })))

  const facts = productRows.flatMap((row) => {
    const sku = skuByExternal.get(row.sku)
    if (!sku) return []
    const returnPercent = reserves.get(row.sku) ?? null
    if (row.commissionPercent == null && row.dimension == null && row.category == null && returnPercent == null) return []
    return [{
      sku_id: sku.id,
      category: row.category,
      commission: row.commissionPercent,
      // Charged per sold unit off the published tariff; a SKU without dimensions pays the
      // maximum rather than nothing, so margin is never flattered by missing data.
      fulfillment_tiyin: fulfillmentTiyin(row.dimension),
      return_percent: returnPercent,
      // Stored so the interface can say what the reserve rests on. A rate over six sales and a
      // rate over six hundred deserve different amounts of trust from the owner.
      return_sample_units: row.soldUnits,
      length: row.dimension?.length ?? null,
      width: row.dimension?.width ?? null,
      height: row.dimension?.height ?? null,
      weight: row.dimension?.weight ?? null,
    }]
  })
  if (facts.length) {
    const { error: factsError } = await db.rpc('commerce_apply_uzum_facts_batch', { p_facts: facts })
    if (factsError) throw factsError
  }
  // Re-read: the recommendations below must see the values the RPC just wrote.
  const { data: refreshed, error: refreshError } = await db.from('commerce_skus')
    .select('id, external_sku, external_product_id, title, unit_cost_tiyin, commission_percent, fulfillment_tiyin, returns_reserve_percent, lead_time_days, moq, safety_stock, min_margin_percent, estimated_fields, economics_revision')
    .eq('catalog_id', typedCatalog.id)
  if (refreshError) throw refreshError
  for (const sku of (refreshed ?? []) as Sku[]) skuByExternal.set(sku.external_sku, sku)
  const productIdCounts = productRows.reduce<Record<string, number>>((out, row) => ({ ...out, ...(row.productId ? { [row.productId]: (out[row.productId] ?? 0) + 1 } : {}) }), {})
  const titleCounts = productRows.reduce<Record<string, number>>((out, row) => ({ ...out, ...(row.name ? { [row.name]: (out[row.name] ?? 0) + 1 } : {}) }), {})

  for (const row of productRows) {
    const sku = skuByExternal.get(row.sku)
    if (!sku) continue
    // Uzum Seller prices are reported in UZS. Commerce storage uses integer tiyin.
    const priceTiyin = row.price == null ? null : nonNegativeInteger(row.price * 100)
    const stock = nonNegativeInteger(row.stock)
    const sold7d = salesFor(row, sales, productIdCounts, titleCounts)
    const snapshot = {
      sku_id: sku.id, sync_run_id: run.id, observed_slot: run.scheduled_for,
      price_tiyin: priceTiyin, stock_total: stock, stock_fbo: nonNegativeInteger(row.stockFbo), stock_fbs: nonNegativeInteger(row.stockFbs), sold_units_7d: sold7d,
      source: { provider: 'uzum', shop_id: typedCatalog.external_shop_id, product_id: row.productId || null, sales_7d_available: sales.ok, product_fields_missing: products.missing },
    }
    const { data: inserted, error: snapshotError } = await db.from('commerce_inventory_snapshots').insert(snapshot).select('id').maybeSingle()
    if (snapshotError && snapshotError.code !== '23505') throw snapshotError
    const existingSnapshot = inserted ? null : await db.from('commerce_inventory_snapshots').select('id').eq('sku_id', sku.id).eq('observed_slot', run.scheduled_for).maybeSingle()
    if (existingSnapshot?.error) throw existingSnapshot.error
    const snapshotId = inserted?.id ?? existingSnapshot?.data?.id
    if (!snapshotId) throw new Error('snapshot could not be read')
    const historyCutoff = new Date(new Date(run.scheduled_for).getTime() - 7 * 86_400_000).toISOString()
    const { data: historical, error: historyError } = await db.from('commerce_inventory_snapshots')
      .select('id').eq('sku_id', sku.id).lte('observed_slot', historyCutoff).limit(1).maybeSingle()
    if (historyError) throw historyError
    const recommendations = recommendation(sku, snapshotId, priceTiyin, stock, sold7d, Boolean(historical))
    if (recommendations.length) {
      const { error: recommendationError } = await db.from('commerce_recommendations').upsert(recommendations, { onConflict: 'dedupe_key' })
      if (recommendationError) throw recommendationError
    }
  }
  const { error: catalogUpdateError } = await db.from('commerce_catalogs').update({ last_synced_at: new Date().toISOString(), last_sync_error: sales.ok ? null : (sales.error ?? 'seven-day sales read failed') }).eq('id', typedCatalog.id)
  if (catalogUpdateError) throw catalogUpdateError
  if (!await finish(db, run, 'completed')) throw new Error('claim lost')
  return 'completed'
}

Deno.serve(async (req) => {
  const authorization = req.headers.get('Authorization') ?? ''
  const cron = req.headers.get('x-cron-secret') ?? ''
  if (authorization !== `Bearer ${SERVICE_ROLE}` && (!CRON_SECRET || cron !== CRON_SECRET)) return json({ error: 'forbidden' }, 403)
  const db = createClient(SUPABASE_URL, SERVICE_ROLE)

  // Field inspection. Uzum's commission is per category and its logistics fee is a function of
  // volume, so before modelling either we have to know whether the product payload actually
  // carries a category and dimensions. Returns FIELD NAMES only — never values — so a schema
  // question can be answered without copying a seller's catalogue anywhere.
  const inspectBody = await req.json().catch(() => ({}))
  if (inspectBody?.action === 'inspect_fields') {
    const { data: catalog } = await db.from('commerce_catalogs')
      .select('id, account_id, external_shop_id').eq('id', String(inspectBody.catalog_id ?? '')).maybeSingle()
    if (!catalog) return json({ error: 'catalog not found' }, 404)
    const { data: keyRow } = await db.from('provider_keys')
      .select('api_key').eq('account_id', catalog.account_id).eq('provider', 'uzum').maybeSingle()
    const token = keyRow?.api_key ? await openSecret(keyRow.api_key, providerSecretContext(catalog.account_id, 'uzum')) : null
    if (!token) return json({ error: 'no uzum key' }, 409)

    // One card is enough to read a schema; a whole page is needed to read what a counter means.
    const size = inspectBody.mode === 'quantities' ? 50 : 1
    const response = await fetch(
      `https://api-seller.uzum.uz/api/seller-openapi/v1/product/shop/${encodeURIComponent(catalog.external_shop_id)}?size=${size}&page=0`,
      // Raw token, no Bearer prefix — Uzum's OpenAPI specifies it that way, and a Bearer
      // prefix is silently answered with 403.
      { headers: { Authorization: token, Accept: 'application/json' } },
    ).catch(() => null)
    if (!response?.ok) return json({ error: `uzum responded ${response?.status ?? 'network error'}` }, 502)
    const payload = await response.json().catch(() => null)
    const list = ['productList', 'payload', 'data', 'result', 'items', 'content']
      .map((key) => payload?.[key])
      .find((value) => Array.isArray(value)) ?? (Array.isArray(payload) ? payload : [])
    const product = list[0] ?? null
    const sku = Array.isArray(product?.skuList) ? product.skuList[0] ?? null : null

    // `quantitySold` sits among a dozen `quantity*` fields that are plainly warehouse states, and
    // the return reserve is derived from it — so what it counts has to be established, not
    // assumed. Sums across the shop answer that: if sold, returned, active and created add up
    // like stock buckets rather than lifetime history, the reserve is built on the wrong number.
    // Counts only. No title, no price, no SKU code leaves this endpoint.
    if (inspectBody.mode === 'quantities') {
      const counters = ['quantityCreated', 'quantitySold', 'quantityReturned', 'quantityActive', 'quantityAvailable', 'quantityMissing', 'quantityDefected', 'quantityPending', 'returnedPercentage', 'avgdsales', 'turnover']
      const sums: Record<string, { sum: number; present: number }> = {}
      let variants = 0
      for (const item of list) {
        const skuList = Array.isArray(item?.skuList) ? item.skuList : [item]
        for (const variant of skuList) {
          variants++
          for (const key of counters) {
            const value = Number(variant?.[key] ?? item?.[key])
            if (!Number.isFinite(value)) continue
            sums[key] = { sum: (sums[key]?.sum ?? 0) + value, present: (sums[key]?.present ?? 0) + 1 }
          }
        }
      }
      return json({ ok: true, products: list.length, variants, sums })
    }
    const wanted = ['category', 'categoryId', 'categoryName', 'category_id', 'length', 'width', 'height', 'volume', 'weight', 'dimensions', 'commission', 'commissionPercent']
    const flatten = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o as Record<string, unknown>) : [])
    // Names only. Values were sampled once to learn whether `commission` is a percentage or an
    // amount; that question is answered (it is a percentage), and a diagnostic endpoint should
    // not keep echoing catalogue data back over the wire.
    return json({
      ok: true,
      envelope_keys: flatten(payload),
      product_keys: flatten(product),
      sku_keys: flatten(sku),
      wanted_present: wanted.filter((k) => flatten(product).includes(k) || flatten(sku).includes(k)),
    })
  }

  // Tashkent has no DST. Convert to local time before flooring a four-hour slot.
  const now = Date.now()
  const tashkent = new Date(now + 5 * 60 * 60 * 1000)
  tashkent.setUTCMinutes(0, 0, 0)
  tashkent.setUTCHours(tashkent.getUTCHours() - tashkent.getUTCHours() % 4)
  const scheduledFor = new Date(tashkent.getTime() - 5 * 60 * 60 * 1000).toISOString()
  const { data: pilots, error: pilotQueueError } = await db.from('commerce_pilots')
    .select('account_id').eq('status', 'active').gt('expires_at', new Date(now).toISOString())
  if (pilotQueueError) return json({ error: 'queue_failed' }, 500)
  const pilotAccountIds = (pilots ?? []).map((pilot: { account_id: string }) => pilot.account_id)
  const { data: catalogs, error: catalogQueueError } = pilotAccountIds.length
    ? await db.from('commerce_catalogs').select('id').eq('status', 'active').in('account_id', pilotAccountIds)
    : { data: [], error: null }
  if (catalogQueueError) return json({ error: 'queue_failed' }, 500)
  if ((catalogs ?? []).length) {
    const { error: queueError } = await db.from('commerce_sync_runs').upsert(
      (catalogs ?? []).map((catalog: { id: string }) => ({ catalog_id: catalog.id, scheduled_for: scheduledFor })),
      { onConflict: 'catalog_id,scheduled_for', ignoreDuplicates: true },
    )
    if (queueError) return json({ error: 'queue_failed' }, 500)
  }
  const { data: claimed, error: claimError } = await db.rpc('claim_commerce_sync_runs', { p_limit: MAX_RUNS })
  if (claimError) return json({ error: 'claim_failed' }, 500)
  const result = { completed: 0, failed: 0, skipped: 0, claim_lost: 0 }
  for (const run of (claimed ?? []) as SyncRun[]) {
    try {
      result[await processRun(db, run)]++
    } catch (error) {
      try {
        if (await finish(db, run, 'failed', String(error instanceof Error ? error.message : error).slice(0, 500))) result.failed++
        else result.claim_lost++
      } catch { result.claim_lost++ }
    }
  }
  if (result.completed) {
    // Dispatch only after snapshots/recommendations are durably committed. Delivery is idempotent.
    await fetch(`${SUPABASE_URL}/functions/v1/commerce-digest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_ROLE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'alerts' }),
    }).catch(() => null)
  }
  return json({ ok: true, claimed: (claimed ?? []).length, ...result })
})
