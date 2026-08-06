import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { uzumShopList } from '../_shared/uzum.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'
import { extractUzumFees, hasAnyFee } from '../_shared/uzumFees.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/

type ImportRow = Record<string, unknown>

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/\s+/g, ' ')
  return normalized && normalized.length <= max ? normalized : null
}

function skuText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= 60 ? normalized : null
}

function integer(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const source = String(value).trim()
  if (!/^-?\d+$/.test(source)) return null
  const parsed = Number(source)
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function decimal(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const source = String(value).trim()
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(source)) return null
  const parsed = Number(source)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null
}

function normalizeRow(value: unknown, rowNumber: number, skuIds: Map<string, string>) {
  const input: ImportRow = value && typeof value === 'object' && !Array.isArray(value) ? value as ImportRow : {}
  const errors: string[] = []
  // Do not fold case or alter internal SKU characters: matching is intentionally exact.
  const externalSku = skuText(input.external_sku)
  if (!externalSku) errors.push('external_sku is required')

  const fields = {
    unit_cost_tiyin: integer(input.unit_cost_tiyin, 0, Number.MAX_SAFE_INTEGER),
    commission_percent: decimal(input.commission_percent, 0, 100),
    fulfillment_tiyin: integer(input.fulfillment_tiyin, 0, Number.MAX_SAFE_INTEGER),
    returns_reserve_percent: decimal(input.returns_reserve_percent, 0, 100),
    lead_time_days: integer(input.lead_time_days, 0, 365),
    moq: integer(input.moq, 1, 10_000_000),
    safety_stock: integer(input.safety_stock, 0, Number.MAX_SAFE_INTEGER),
    min_margin_percent: decimal(input.min_margin_percent, 0, 99.9999),
  }
  for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
    if (input[key] !== null && input[key] !== undefined && input[key] !== '' && fields[key] === null) errors.push(`${key} is invalid`)
  }
  if (Object.values(fields).every((field) => field === null)) errors.push('at least one economics field is required')

  const raw = { external_sku: externalSku, ...fields }
  const matchedSkuId = externalSku ? skuIds.get(externalSku) ?? null : null
  return {
    batch_id: '',
    row_number: rowNumber,
    raw,
    external_sku: externalSku,
    matched_sku_id: errors.length ? null : matchedSkuId,
    match_status: errors.length ? 'invalid' : matchedSkuId ? 'matched' : 'unmatched',
    errors,
    ...fields,
  }
}

async function catalogForAccount(admin: ReturnType<typeof createClient>, accountId: string, catalogId: unknown) {
  if (typeof catalogId !== 'string' || !UUID.test(catalogId)) return null
  const { data } = await admin.from('commerce_catalogs').select('id').eq('id', catalogId).eq('account_id', accountId).maybeSingle()
  return data
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req)
  if (preflight) return preflight
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization) return json({ error: 'unauthorized' }, 401)
  const userDb = createClient(URL, ANON, { global: { headers: { Authorization: authorization } } })
  const { data: { user } } = await userDb.auth.getUser()
  if (!user) return json({ error: 'unauthorized' }, 401)
  const { data: profile } = await userDb.from('users').select('account_id, role').eq('id', user.id).maybeSingle()
  if (!profile?.account_id) return json({ error: 'no account' }, 403)

  const body = await req.json().catch(() => ({}))
  const action = typeof body?.action === 'string' ? body.action : ''
  const admin = createClient(URL, SERVICE)
  const ownerAction = action === 'start_pilot' || action === 'discover_uzum' || action === 'stage_import' || action === 'resolve_import_row' || action === 'confirm_import' || action === 'create_telegram_link' || action === 'autofill_economics' || action === 'update_sku_economics' || action === 'propose_fees' || action === 'propose_min_margin' || action === 'apply_proposal' || action === 'reject_proposal'
  if (ownerAction && profile.role !== 'owner') return json({ error: 'owner role required' }, 403)

  if (action === 'status') {
    const [{ data: pilot }, { data: catalogs, error }, { data: notificationProfile }] = await Promise.all([
      admin.from('commerce_pilots').select('status, started_at, expires_at, read_only_at').eq('account_id', profile.account_id).maybeSingle(),
      admin.from('commerce_catalogs').select('id, name, source, external_shop_id, status, last_synced_at, last_sync_error').eq('account_id', profile.account_id).order('created_at', { ascending: false }),
      admin.from('business_profiles').select('notify_chat_id').eq('account_id', profile.account_id).maybeSingle(),
    ])
    if (error) return json({ error: 'could not load commerce status' }, 500)
    return json({ ok: true, pilot: pilot ?? null, catalogs: catalogs ?? [], telegram_connected: Boolean(notificationProfile?.notify_chat_id) })
  }

  if (action === 'start_pilot') {
    const { data: existing } = await admin.from('commerce_pilots').select('status, expires_at').eq('account_id', profile.account_id).maybeSingle()
    if (existing) return json({ error: existing.status === 'active' ? 'commerce pilot is already active' : 'commerce pilot has ended' }, 409)
    const { data: pilot, error } = await admin.from('commerce_pilots').insert({ account_id: profile.account_id })
      .select('status, started_at, expires_at, read_only_at').single()
    return error || !pilot ? json({ error: 'could not start commerce pilot' }, 500) : json({ ok: true, pilot })
  }

  if (action === 'create_telegram_link') {
    const { data: agents } = await admin.from('agents').select('id').eq('account_id', profile.account_id).limit(20)
    const ids = (agents ?? []).map((agent: { id: string }) => agent.id)
    // Deterministic choice (oldest connected bot) so the link always points at the same bot and the
    // owner is not sent to a different one on every click.
    const { data: channel } = ids.length ? await admin.from('channels').select('id, credentials').eq('type', 'telegram').in('agent_id', ids).eq('status', 'connected').order('created_at', { ascending: true }).limit(1).maybeSingle() : { data: null }
    const username = typeof channel?.credentials?.username === 'string' ? channel.credentials.username.replace(/^@/, '') : ''
    if (!username) return json({ error: 'Connect a Telegram bot in AI Teams first' }, 409)
    const { data: link, error } = await admin.from('commerce_telegram_links').insert({ account_id: profile.account_id, channel_id: channel?.id ?? null }).select('token').single()
    if (error || !link) return json({ error: 'could not create Telegram link' }, 500)
    return json({ ok: true, url: `https://t.me/${username}?start=commerce_${link.token}` })
  }

  if (action === 'list') {
    const catalog = body?.catalog_id ? await catalogForAccount(admin, profile.account_id, body.catalog_id) : null
    if (body?.catalog_id && !catalog) return json({ error: 'catalog not found' }, 404)
    if (body?.batch_id) {
      if (typeof body.batch_id !== 'string' || !UUID.test(body.batch_id)) return json({ error: 'invalid batch_id' }, 400)
      const { data: batch } = await admin.from('commerce_import_batches').select('id, catalog_id, status, total_rows, valid_rows, unmatched_rows, error_rows, created_at, confirmed_at').eq('id', body.batch_id).eq('account_id', profile.account_id).maybeSingle()
      if (!batch || (catalog && batch.catalog_id !== catalog.id)) return json({ error: 'batch not found' }, 404)
      const { data: rows, error } = await admin.from('commerce_import_rows').select('id, row_number, external_sku, matched_sku_id, match_status, errors, unit_cost_tiyin, commission_percent, fulfillment_tiyin, returns_reserve_percent, lead_time_days, moq, safety_stock, min_margin_percent').eq('batch_id', batch.id).order('row_number').limit(500)
      return error ? json({ error: 'could not load import rows' }, 500) : json({ ok: true, batch, rows: rows ?? [] })
    }
    let query = admin.from('commerce_import_batches').select('id, catalog_id, file_name, status, total_rows, valid_rows, unmatched_rows, error_rows, created_at, confirmed_at').eq('account_id', profile.account_id).order('created_at', { ascending: false }).limit(50)
    if (catalog) query = query.eq('catalog_id', catalog.id)
    const { data: batches, error } = await query
    return error ? json({ error: 'could not load imports' }, 500) : json({ ok: true, batches: batches ?? [] })
  }

  if (action === 'discover_uzum') {
    if (await blocksExternalActions(admin, profile.account_id)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
    const { data: keyRow } = await admin.from('provider_keys').select('api_key')
      .eq('account_id', profile.account_id).eq('provider', 'uzum').maybeSingle()
    const key = await openSecret(keyRow?.api_key, providerSecretContext(profile.account_id, 'uzum'))
    if (!key) return json({ error: 'Uzum provider key is not connected' }, 409)
    const listed = await uzumShopList(key)
    if (!listed.ok) return json({ error: listed.error ?? 'could not read Uzum shops' }, 502)
    const { data: catalogs, error } = await admin.from('commerce_catalogs').upsert(
      listed.shops.map((shop) => ({ account_id: profile.account_id, source: 'uzum', external_shop_id: shop.id, name: shop.name })),
      { onConflict: 'account_id,source,external_shop_id' },
    ).select('id, name, external_shop_id, status')
    return error ? json({ error: 'could not save Uzum catalogs' }, 500) : json({ ok: true, catalogs: catalogs ?? [] })
  }

  if (action === 'stage_import') {
    const catalog = await catalogForAccount(admin, profile.account_id, body?.catalog_id)
    const fileName = text(body?.file_name, 180)
    const fileHash = typeof body?.file_sha256 === 'string' ? body.file_sha256.toLowerCase() : ''
    const inputRows = body?.rows
    if (!catalog) return json({ error: 'catalog not found' }, 404)
    if (!fileName || !SHA256.test(fileHash)) return json({ error: 'invalid file metadata' }, 400)
    if (!Array.isArray(inputRows) || inputRows.length < 1 || inputRows.length > 500) return json({ error: 'rows must contain 1 to 500 items' }, 400)

    const { data: skus, error: skuError } = await admin.from('commerce_skus').select('id, external_sku').eq('catalog_id', catalog.id)
    if (skuError) return json({ error: 'could not load catalog SKUs' }, 500)
    const skuIds = new Map((skus ?? []).map((sku) => [sku.external_sku, sku.id]))
    const rows = inputRows.map((row, index) => normalizeRow(row, index + 1, skuIds))
    const errorRows = rows.filter((row) => row.match_status === 'invalid').length
    const unmatchedRows = rows.filter((row) => row.match_status === 'unmatched').length
    const { data: batch, error: batchError } = await admin.from('commerce_import_batches').insert({
      account_id: profile.account_id,
      catalog_id: catalog.id,
      created_by: user.id,
      file_name: fileName,
      file_sha256: fileHash,
      total_rows: rows.length,
      valid_rows: rows.length - errorRows,
      unmatched_rows: unmatchedRows,
      error_rows: errorRows,
    }).select('id, status, total_rows, valid_rows, unmatched_rows, error_rows').single()
    if (batchError || !batch) return json({ error: batchError?.code === '23505' ? 'import already staged' : 'could not stage import' }, batchError?.code === '23505' ? 409 : 500)
    const insertRows = rows.map((row) => {
      const copy = { ...row }
      delete copy.batch_id
      return { ...copy, batch_id: batch.id }
    })
    const { error: rowsError } = await admin.from('commerce_import_rows').insert(insertRows)
    if (rowsError) {
      await admin.from('commerce_import_batches').delete().eq('id', batch.id).eq('account_id', profile.account_id)
      return json({ error: 'could not stage import rows' }, 500)
    }
    return json({ ok: true, batch })
  }

  if (action === 'list_skus') {
    const catalog = await catalogForAccount(admin, profile.account_id, body?.catalog_id)
    if (!catalog) return json({ error: 'catalog not found' }, 404)
    const { data: skus, error } = await admin.from('commerce_skus')
      .select('id, external_sku, title, unit_cost_tiyin, commission_percent, fulfillment_tiyin, returns_reserve_percent, lead_time_days, moq, safety_stock, min_margin_percent, estimated_fields, economics_revision')
      .eq('catalog_id', catalog.id).order('title').limit(500)
    if (error) return json({ error: 'could not load SKUs' }, 500)
    const { data: run } = await admin.from('commerce_sync_runs').select('id, scheduled_for')
      .eq('catalog_id', catalog.id).eq('status', 'completed').order('scheduled_for', { ascending: false }).limit(1).maybeSingle()
    const snapshotBySku = new Map<string, unknown>()
    if (run && (skus ?? []).length) {
      const { data: snapshots } = await admin.from('commerce_inventory_snapshots')
        .select('sku_id, price_tiyin, stock_total, sold_units_7d').eq('sync_run_id', run.id)
      for (const snapshot of snapshots ?? []) snapshotBySku.set(snapshot.sku_id, snapshot)
    }
    return json({ ok: true, observed_at: run?.scheduled_for ?? null, skus: (skus ?? []).map((sku) => ({ ...sku, snapshot: snapshotBySku.get(sku.id) ?? null })) })
  }

  if (action === 'autofill_economics') {
    const catalog = await catalogForAccount(admin, profile.account_id, body?.catalog_id)
    if (!catalog) return json({ error: 'catalog not found' }, 404)
    // The RPC re-checks the owner via auth.uid(), so invoke it through the caller JWT.
    const { data, error } = await userDb.rpc('autofill_commerce_economics', { p_catalog_id: catalog.id })
    if (error) return json({ error: error.code === '23514' ? 'run a catalog sync before auto-filling estimates' : 'could not auto-fill estimates' }, error.code === '23514' ? 409 : 500)
    return json({ ok: true, result: data })
  }

  if (action === 'update_sku_economics') {
    if (typeof body?.sku_id !== 'string' || !UUID.test(body.sku_id)) return json({ error: 'invalid sku_id' }, 400)
    const validators: Record<string, (value: unknown) => number | null> = {
      unit_cost_tiyin: (value) => integer(value, 0, Number.MAX_SAFE_INTEGER),
      commission_percent: (value) => decimal(value, 0, 100),
      fulfillment_tiyin: (value) => integer(value, 0, Number.MAX_SAFE_INTEGER),
      returns_reserve_percent: (value) => decimal(value, 0, 100),
      lead_time_days: (value) => integer(value, 0, 365),
      moq: (value) => integer(value, 1, 10_000_000),
      safety_stock: (value) => integer(value, 0, Number.MAX_SAFE_INTEGER),
      min_margin_percent: (value) => decimal(value, 0, 99.9999),
    }
    const updates: Record<string, number> = {}
    for (const [field, validate] of Object.entries(validators)) {
      const value = body?.[field]
      if (value === null || value === undefined || value === '') continue
      const parsed = validate(value)
      if (parsed === null) return json({ error: `${field} is invalid` }, 400)
      updates[field] = parsed
    }
    const providedKeys = Object.keys(updates)
    if (!providedKeys.length) return json({ error: 'at least one economics field is required' }, 400)
    const { data: sku } = await admin.from('commerce_skus').select('id, catalog_id, estimated_fields, economics_revision').eq('id', body.sku_id).maybeSingle()
    if (!sku || !(await catalogForAccount(admin, profile.account_id, sku.catalog_id))) return json({ error: 'sku not found' }, 404)
    // An explicit owner value confirms the field: its estimate mark is removed.
    const estimatedFields = (Array.isArray(sku.estimated_fields) ? sku.estimated_fields : [])
      .filter((field: unknown) => typeof field === 'string' && !providedKeys.includes(field))
    const { data: updated, error } = await admin.from('commerce_skus').update({
      ...updates,
      estimated_fields: estimatedFields,
      economics_revision: sku.economics_revision + 1,
      economics_updated_at: new Date().toISOString(),
      economics_updated_by: user.id,
    }).eq('id', sku.id).eq('economics_revision', sku.economics_revision).select('id')
    if (error) return json({ error: 'could not update SKU economics' }, 500)
    if (!updated?.length) return json({ error: 'SKU was updated concurrently, reload and retry' }, 409)
    return json({ ok: true, sku_id: sku.id, updated: providedKeys, estimated_fields: estimatedFields })
  }

  if (action === 'propose_fees') {
    const catalog = await catalogForAccount(admin, profile.account_id, body?.catalog_id)
    if (!catalog) return json({ error: 'catalog not found' }, 404)
    // Only the seller cabinet can state a seller's fees, so only an observation of it counts.
    const { data: observation } = await admin.from('browser_observations')
      .select('id, source_url, body_text, observed_at')
      .eq('account_id', profile.account_id).gt('expires_at', new Date().toISOString())
      .order('observed_at', { ascending: false }).limit(1).maybeSingle()
    if (!observation?.body_text) return json({ error: 'no recent seller-cabinet observation' }, 409)

    const fees = extractUzumFees(observation.body_text)
    if (!hasAnyFee(fees)) return json({ error: 'no fees recognised on that page', evidence: [] }, 422)

    const { data: proposal, error } = await admin.from('commerce_economics_proposals').insert({
      account_id: profile.account_id,
      catalog_id: catalog.id,
      source: 'browser',
      product_query: 'catalogue fees',
      source_text: observation.source_url ?? 'seller cabinet',
      commission_percent: fees.commission_percent,
      fulfillment_tiyin: fees.fulfillment_tiyin,
      returns_reserve_percent: fees.returns_reserve_percent,
    }).select('id, commission_percent, fulfillment_tiyin, returns_reserve_percent, expires_at').single()
    if (error || !proposal) return json({ error: 'could not prepare the fee proposal' }, 500)
    return json({ ok: true, proposal, evidence: fees.evidence, observed_at: observation.observed_at })
  }

  if (action === 'propose_min_margin') {
    const catalog = await catalogForAccount(admin, profile.account_id, body?.catalog_id)
    if (!catalog) return json({ error: 'catalog not found' }, 404)
    const margin = decimal(body?.min_margin_percent, 0, 99.9999)
    if (margin === null) return json({ error: 'min_margin_percent is invalid' }, 400)
    // How many SKUs this would actually touch, so the confirmation states a real number rather
    // than the catalogue size. Products that already carry a margin are left alone.
    const { count } = await admin.from('commerce_skus')
      .select('id', { count: 'exact', head: true })
      .eq('catalog_id', catalog.id).is('min_margin_percent', null)
    const { data: proposal, error } = await admin.from('commerce_economics_proposals').insert({
      account_id: profile.account_id,
      catalog_id: catalog.id,
      source: 'ui',
      product_query: 'catalogue minimum margin',
      source_text: `owner set ${margin}%`,
      min_margin_percent: margin,
    }).select('id, min_margin_percent, expires_at').single()
    if (error || !proposal) return json({ error: 'could not prepare the margin proposal' }, 500)
    return json({ ok: true, proposal, affected: count ?? 0 })
  }

  if (action === 'list_proposals') {
    const { data, error } = await admin.from('commerce_economics_proposals')
      .select('id, source, status, product_query, source_text, sku_id, catalog_id, unit_cost_tiyin, lead_time_days, safety_stock, min_margin_percent, commission_percent, fulfillment_tiyin, returns_reserve_percent, expires_at, created_at, commerce_skus(title, external_sku)')
      .eq('account_id', profile.account_id).eq('status', 'pending')
      .gt('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(20)
    return error ? json({ error: 'could not load proposals' }, 500) : json({ ok: true, proposals: data ?? [] })
  }

  if (action === 'apply_proposal' || action === 'reject_proposal') {
    if (typeof body?.proposal_id !== 'string' || !UUID.test(body.proposal_id)) return json({ error: 'invalid proposal_id' }, 400)
    // Ownership is re-checked here rather than trusted from the client: the RPC runs as
    // service_role and would otherwise apply any account's proposal.
    const { data: proposal } = await admin.from('commerce_economics_proposals')
      .select('id, status').eq('id', body.proposal_id).eq('account_id', profile.account_id).maybeSingle()
    if (!proposal || proposal.status !== 'pending') return json({ error: 'pending proposal not found' }, 404)

    if (action === 'reject_proposal') {
      const { error } = await admin.from('commerce_economics_proposals')
        .update({ status: 'rejected' }).eq('id', proposal.id).eq('status', 'pending')
      return error ? json({ error: 'could not reject the proposal' }, 500) : json({ ok: true, rejected: true })
    }
    const { data, error } = await admin.rpc('apply_commerce_economics_proposal', { p_proposal_id: proposal.id })
    return error ? json({ error: 'could not apply the proposal' }, 409) : json({ ok: true, result: data })
  }

  if (action === 'resolve_import_row') {
    if (typeof body?.batch_id !== 'string' || typeof body?.row_id !== 'string' || typeof body?.sku_id !== 'string' || !UUID.test(body.batch_id) || !UUID.test(body.row_id) || !UUID.test(body.sku_id)) return json({ error: 'invalid identifiers' }, 400)
    const { data: batch } = await admin.from('commerce_import_batches').select('id, catalog_id, status').eq('id', body.batch_id).eq('account_id', profile.account_id).maybeSingle()
    if (!batch || batch.status !== 'staged') return json({ error: 'staged batch not found' }, 404)
    const [{ data: row }, { data: sku }] = await Promise.all([
      admin.from('commerce_import_rows').select('id, errors').eq('id', body.row_id).eq('batch_id', batch.id).maybeSingle(),
      admin.from('commerce_skus').select('id').eq('id', body.sku_id).eq('catalog_id', batch.catalog_id).maybeSingle(),
    ])
    if (!row || !sku) return json({ error: 'row or SKU not found in this catalog' }, 404)
    if (Array.isArray(row.errors) && row.errors.length) return json({ error: 'invalid row cannot be resolved' }, 409)
    const { error } = await admin.from('commerce_import_rows').update({ matched_sku_id: sku.id, match_status: 'matched' }).eq('id', row.id).eq('batch_id', batch.id)
    return error ? json({ error: 'could not resolve import row' }, 500) : json({ ok: true, row_id: row.id, sku_id: sku.id })
  }

  if (action === 'confirm_import') {
    if (typeof body?.batch_id !== 'string' || !UUID.test(body.batch_id)) return json({ error: 'invalid batch_id' }, 400)
    // The RPC relies on auth.uid(), so invoke it through the caller JWT after the owner check.
    const { data, error } = await userDb.rpc('confirm_commerce_import', { p_batch_id: body.batch_id })
    if (error) return json({ error: error.code === 'P0002' ? 'batch not found' : 'could not confirm import' }, error.code === 'P0002' ? 404 : 409)
    return json({ ok: true, result: data })
  }

  return json({ error: 'unknown action' }, 400)
})
