// Read-only Uzum catalogue synchronizer. Invoked only by pg_cron or a service-role dispatch.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { json } from '../_shared/cors.ts'
import { uzumProductRows, uzumSalesRows, type UzumProductRow } from '../_shared/uzum.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'

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
    if (dailyVelocity > 0 && stock <= reorderPoint) rows.push({
      ...base, kind: 'reorder', severity: severityFor(stock / dailyVelocity <= sku.lead_time_days, reorderInputs),
      dedupe_key: `commerce:${sku.id}:reorder`,
      calculation: { sold_units_7d: sold7d, daily_velocity: dailyVelocity, stock_total: stock, lead_time_days: sku.lead_time_days, safety_stock: sku.safety_stock, reorder_point: reorderPoint, target_units: targetUnits, reorder_units: units, estimated_inputs: estimatesUsed(reorderInputs) },
      suggested_action: { type: 'review_reorder', units }, last_detected_at: new Date().toISOString(),
    })
  }

  if (priceTiyin != null && sku.unit_cost_tiyin != null && sku.commission_percent != null && sku.fulfillment_tiyin != null && sku.returns_reserve_percent != null && sku.min_margin_percent != null && priceTiyin > 0) {
    const net = priceTiyin - sku.unit_cost_tiyin - sku.fulfillment_tiyin - priceTiyin * (sku.commission_percent + sku.returns_reserve_percent) / 100
    const marginPercent = net / priceTiyin * 100
    const priceInputs = ['unit_cost_tiyin', 'fulfillment_tiyin', 'commission_percent', 'returns_reserve_percent', 'min_margin_percent']
    if (marginPercent < sku.min_margin_percent) rows.push({
      ...base, kind: 'price_guard', severity: severityFor(marginPercent <= 0, priceInputs), dedupe_key: `commerce:${sku.id}:price_guard`,
      calculation: { price_tiyin: priceTiyin, unit_cost_tiyin: sku.unit_cost_tiyin, fulfillment_tiyin: sku.fulfillment_tiyin, commission_percent: sku.commission_percent, returns_reserve_percent: sku.returns_reserve_percent, margin_percent: marginPercent, min_margin_percent: sku.min_margin_percent, estimated_inputs: estimatesUsed(priceInputs) },
      suggested_action: { type: 'review_price', minimum_margin_percent: sku.min_margin_percent }, last_detected_at: new Date().toISOString(),
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
  if (!products.ok) throw new Error(products.error ?? 'Uzum product read failed')
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
