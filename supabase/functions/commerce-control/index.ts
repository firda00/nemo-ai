import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.108.2'
import { corsPreflight, json } from '../_shared/cors.ts'
import { uzumShopList } from '../_shared/uzum.ts'
import { openSecret, providerSecretContext } from '../_shared/secretBox.ts'
import { blocksExternalActions, PRODUCTION_E2E_EXTERNAL_BLOCK } from '../_shared/productionE2E.ts'
import { extractUzumFees, hasAnyFee } from '../_shared/uzumFees.ts'
import {
  categoryCandidates,
  draftEconomics,
  extractNumbers,
  generateCopy,
  manualCategory,
  OWNER_STATED_FEE_FIELDS,
} from '../_shared/listingDraft.ts'
import { catalogueContext } from '../_shared/commerceListingChat.ts'
import { entitlementFor, lockMessage } from '../_shared/entitlement.ts'
import { signImages } from '../_shared/listingImages.ts'
import { PLAN_SYSTEM_PROMPT, checkPlan, planNote, planUserPrompt } from '../_shared/agentPlan.ts'
import {
  classifyProviderResponse, decideSubmit, ownerMessage,
  type SubmitMode,
} from '../_shared/listingSubmit.ts'
import { generateVision, mergeVisionIntoSource } from '../_shared/listingVision.ts'
import { parseLabels, TRANSLATE_SYSTEM_PROMPT, type CategoryLabel } from '../_shared/categoryLabels.ts'

import { resolveOpenRouterKey } from '../_shared/keys.ts'
import { callOpenRouter, PRIMARY_MODEL, stripJsonFence } from '../_shared/llm.ts'

const URL = Deno.env.get('SUPABASE_URL')!
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256 = /^[a-f0-9]{64}$/

/**
 * Подписи полок на русском и английском: из справочника, а новые — переводом.
 *
 * Справочник платформенный: полки Uzum одни и те же у всех продавцов, и перевод, купленный на
 * одном аккаунте, достаётся остальным даром. У продавца их дюжина, так что перевод случается
 * один раз в жизни полки и больше никогда.
 *
 * Отказ модели ничего не ломает: вернутся те подписи, что уже есть, а непереведённая полка
 * покажется узбекским именем — тем самым, которое владелец видит в кабинете Uzum.
 */
async function resolveCategoryLabels(db: any, names: string[]): Promise<Record<string, CategoryLabel>> {
  const wanted = names.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200)
  if (!wanted.length) return {}
  const { data: known } = await db.from('commerce_category_labels').select('category, label_ru, label_en').in('category', wanted)
  const out: Record<string, CategoryLabel> = {}
  for (const row of known ?? []) out[row.category] = row

  const missing = wanted.filter((name) => !out[name])
  if (!missing.length) return out

  const apiKey = Deno.env.get('OPENROUTER_API_KEY') ?? ''
  if (!apiKey) return out
  const translated = await callOpenRouter({
    apiKey,
    model: PRIMARY_MODEL,
    temperature: 0,
    maxTokens: 1200,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(missing.slice(0, 40)) },
    ],
  })
    .then((res) => parseLabels(JSON.parse(stripJsonFence(res.content)), missing))
    .catch(() => [] as CategoryLabel[])

  if (translated.length) {
    // Слово владельца переводом не затирается: onConflict обновляет только машинные строки.
    await db.from('commerce_category_labels')
      .upsert(translated.map((row) => ({ ...row, source: 'model', updated_at: new Date().toISOString() })), { onConflict: 'category' })
    for (const row of translated) out[row.category] = row
  }
  return out
}

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

/**
 * Одна дорога для «Полной автономии» и для ручной кнопки.
 *
 * Два разных пути к отправке разошлись бы через месяц, и ручная кнопка начала бы проверять не то,
 * что проверяет автомат. Проверка одна, журнал один, объяснение одно.
 *
 * ОТПРАВКИ ПОКА НЕТ. Внешние адреса создания товара Uzum закрывает 403 для ключа продавца —
 * проверено на боевом ключе: 200 на маршрутах чтения каталога, 403 на девяти адресах создания.
 * Поэтому попытка честно доходит до сети, получает отказ и ложится в журнал названной причиной,
 * а владелец читает, что и у кого просить. Заглушки, возвращающей «успех», здесь нет: она
 * сообщала бы, что товар уехал, и продавец узнавал бы правду через сутки, не найдя его в кабинете.
 */
async function submitDraft(admin: ReturnType<typeof createClient>, input: {
  draftId: string; accountId: string; userId: string; mode: SubmitMode; lang: string
}) {
  const { data: draft } = await admin.from('commerce_listing_drafts')
    .select('id, status, title_ru, title_uz, uzum_category, missing')
    .eq('id', input.draftId).eq('account_id', input.accountId).maybeSingle()

  const access = await entitlementFor(admin, input.accountId)
  // Роль уже проверена выше по списку owner-действий; здесь она передаётся честно, а не
  // подразумевается: решение обязано быть проверяемым в отрыве от вызывающего.
  const decision = decideSubmit({ draft, isOwner: true, entitled: access.allowed })

  const record = async (row: Record<string, unknown>) => {
    const payload = {
      draft_id: input.draftId, account_id: input.accountId, mode: input.mode,
      transport: 'uzum_api', attempted_by: input.userId, ...row,
    }
    await admin.from('commerce_listing_submissions').insert(payload)
    return payload
  }

  if (!decision.attempt) {
    return await record({
      status: 'refused', reason: decision.reason,
      owner_message: ownerMessage(decision.reason, input.lang),
    })
  }

  const { data: keyRow } = await admin.from('provider_keys').select('api_key')
    .eq('account_id', input.accountId).eq('provider', 'uzum').maybeSingle()
  const token = await openSecret(keyRow?.api_key, providerSecretContext(input.accountId, 'uzum'))
  if (!token) {
    return await record({ status: 'refused', reason: 'no_key', owner_message: ownerMessage('no_key', input.lang) })
  }

  const response = await fetch('https://api-seller.uzum.uz/api/seller-openapi/v1/product', {
    method: 'POST',
    // Сырой токен без Bearer — так устроен OpenAPI Uzum; с префиксом он молча отвечает 403.
    headers: { Authorization: token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ draft_id: input.draftId }),
  }).catch(() => null)
  const httpStatus = response?.status ?? 0
  const text = response ? (await response.text().catch(() => '')).slice(0, 4000) : ''
  const outcome = classifyProviderResponse(httpStatus)

  if (outcome.status === 'sent') {
    await admin.from('commerce_listing_drafts')
      .update({ status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', input.draftId).eq('account_id', input.accountId)
  }
  return await record({
    status: outcome.status, reason: outcome.reason, http_status: httpStatus,
    provider_response: text || null,
    owner_message: outcome.status === 'sent' ? null : ownerMessage(outcome.reason, input.lang),
  })
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
  // Язык объяснений. Отказ, показанный не на языке владельца, читается как сбой.
  const lang = typeof body?.lang === 'string' ? body.lang : 'ru'
  const action = typeof body?.action === 'string' ? body.action : ''
  const admin = createClient(URL, SERVICE)
  const ownerAction = action === 'start_pilot' || action === 'discover_uzum' || action === 'stage_import' || action === 'resolve_import_row' || action === 'confirm_import' || action === 'create_telegram_link' || action === 'autofill_economics' || action === 'update_sku_economics' || action === 'propose_fees' || action === 'propose_min_margin' || action === 'sync_now' || action === 'apply_proposal' || action === 'reject_proposal'
    || action === 'draft_listing' || action === 'approve_listing_draft' || action === 'discard_listing_draft'
    || action === 'set_listing_category' || action === 'onboard'
    // Отправка на площадку и переключение режима — деньги и репутация владельца, не сотрудника.
    || action === 'submit_listing' || action === 'set_auto_submit'
    || action === 'next_extension_task' || action === 'report_extension_result' || action === 'agent_plan'
  if (ownerAction && profile.role !== 'owner') return json({ error: 'owner role required' }, 403)

  if (action === 'status') {
    const [{ data: pilot }, { data: catalogs, error }, { data: notificationProfile }] = await Promise.all([
      admin.from('commerce_pilots').select('status, started_at, expires_at, read_only_at, auto_submit_to_moderation, auto_extension_submit').eq('account_id', profile.account_id).maybeSingle(),
      admin.from('commerce_catalogs').select('id, name, source, external_shop_id, status, last_synced_at, last_sync_error').eq('account_id', profile.account_id).order('created_at', { ascending: false }),
      admin.from('business_profiles').select('notify_chat_id, notify_channel_id').eq('account_id', profile.account_id).maybeSingle(),
    ])
    if (error) return json({ error: 'could not load commerce status' }, 500)

    // Какой именно бот обслуживает этот магазин. Связь существовала только в базе: владелец
    // выяснял имя бота перепиской, а имя агента ему в этом врало — «Создай AI-команду для
    // управления магазином» звучит как нужный бот и им не является. Один запрос вместо догадки.
    let notifyBot: string | null = null
    if (notificationProfile?.notify_channel_id) {
      const { data: channel } = await admin.from('channels')
        .select('credentials').eq('id', notificationProfile.notify_channel_id).maybeSingle()
      const username = channel?.credentials?.username
      notifyBot = typeof username === 'string' && username ? username : null
    }

    return json({
      ok: true, pilot: pilot ?? null, catalogs: catalogs ?? [],
      telegram_connected: Boolean(notificationProfile?.notify_chat_id),
      notify_bot: notifyBot,
    })
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

  // Закрепить магазин за аккаунтом в момент подключения — единственная точка, где мы вообще узнаём
  // его номер. Без этого вызова правило «триал за магазином, а не за почтой» существует только в
  // базе: заявок никто не создаёт, значит и занятых магазинов нет, и новая почта каждые три дня
  // снова даёт бесплатный период.
  //
  // Отказ НЕ ломает подключение: продавец имеет право подключить чужой по заявке магазин, он просто
  // не получит за него второго триала. Ошибка вызова тоже не ломает — каталог уже сохранён, и
  // потерять подключение из-за учёта пробных периодов было бы хуже, чем потерять учёт.
  async function claimShops(shops: Array<{ external_shop_id?: string | null }>) {
    for (const shop of shops) {
      const shopId = String(shop.external_shop_id ?? '')
      if (!shopId) continue
      const { error } = await admin.rpc('claim_shop_trial', { p_account_id: profile.account_id, p_shop_id: shopId })
      if (error) console.error('claim_shop_trial failed:', shopId, error.message)
    }
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
    if (!error) await claimShops(catalogs ?? [])
    return error ? json({ error: 'could not save Uzum catalogs' }, 500) : json({ ok: true, catalogs: catalogs ?? [] })
  }

  // One call from "the key was accepted" to "the first audit is running". A new seller had to
  // find and press four separate buttons in the right order — start the pilot, discover shops,
  // pick a catalogue, sync — and any one of them missed left the page looking broken. Every step
  // here is idempotent: pressing it twice costs a second read and changes nothing.
  if (action === 'onboard') {
    if (await blocksExternalActions(admin, profile.account_id)) return json(PRODUCTION_E2E_EXTERNAL_BLOCK, 403)
    const { data: keyRow } = await admin.from('provider_keys').select('api_key')
      .eq('account_id', profile.account_id).eq('provider', 'uzum').maybeSingle()
    const key = await openSecret(keyRow?.api_key, providerSecretContext(profile.account_id, 'uzum'))
    if (!key) return json({ error: 'connect the Uzum key first', step: 'key' }, 409)

    // An already-running pilot is the desired state, not a conflict — unlike start_pilot, which
    // is a deliberate action and says so when repeated.
    const { data: pilot } = await admin.from('commerce_pilots').select('status, expires_at')
      .eq('account_id', profile.account_id).maybeSingle()
    if (!pilot) {
      const { error: pilotError } = await admin.from('commerce_pilots').insert({ account_id: profile.account_id })
      if (pilotError) return json({ error: 'could not start the pilot', step: 'pilot' }, 500)
    } else if (pilot.status !== 'active') {
      return json({ error: 'the commerce pilot has ended', step: 'pilot' }, 409)
    }

    const listed = await uzumShopList(key)
    if (!listed.ok) return json({ error: listed.error ?? 'could not read Uzum shops', step: 'shops' }, 502)
    if (!listed.shops.length) return json({ error: 'the key sees no shops — grant it access in the Uzum Seller cabinet', step: 'shops' }, 409)
    const { data: catalogs, error: catalogError } = await admin.from('commerce_catalogs').upsert(
      listed.shops.map((shop) => ({ account_id: profile.account_id, source: 'uzum', external_shop_id: shop.id, name: shop.name })),
      { onConflict: 'account_id,source,external_shop_id' },
    ).select('id, name, external_shop_id, status')
    if (catalogError) return json({ error: 'could not save the shops', step: 'shops' }, 500)
    await claimShops(catalogs ?? [])

    // Queue one run per catalogue that has none waiting. Without this check a second press would
    // stack duplicate runs that each re-read the same shop.
    const active = (catalogs ?? []).filter((catalog) => catalog.status === 'active')
    const { data: pendingRuns } = await admin.from('commerce_sync_runs')
      .select('catalog_id').in('catalog_id', active.map((catalog) => catalog.id)).in('status', ['queued', 'running'])
    const alreadyQueued = new Set((pendingRuns ?? []).map((run: { catalog_id: string }) => run.catalog_id))
    const toQueue = active.filter((catalog) => !alreadyQueued.has(catalog.id))
    if (toQueue.length) {
      const { error: queueError } = await admin.from('commerce_sync_runs')
        .insert(toQueue.map((catalog) => ({ catalog_id: catalog.id, status: 'queued', scheduled_for: new Date().toISOString() })))
      if (queueError) return json({ error: 'could not queue the first sync', step: 'sync' }, 500)
    }

    // Kick the worker without blocking the response: a first sync of several shops runs past this
    // function's own time limit, and a timeout here would look like a failure while the sync was
    // fine.
    //
    // Through waitUntil, NOT a bare un-awaited fetch. The isolate is torn down as soon as the
    // response is returned, so a promise nobody is holding may never be sent at all — the runs
    // would sit queued until the four-hourly cron, while the page polled for two minutes and
    // showed the seller nothing. waitUntil is what keeps the isolate alive for it.
    const kick = fetch(`${URL}/functions/v1/commerce-worker`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'manual' }),
    }).catch(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runtime = (globalThis as any).EdgeRuntime
    if (runtime?.waitUntil) runtime.waitUntil(kick)

    return json({
      ok: true,
      shops: (catalogs ?? []).length,
      queued: toQueue.length,
      catalogs: catalogs ?? [],
      // The page polls status; saying "started" rather than "done" is the difference between a
      // spinner that ends and one that lies.
      sync_started: true,
    })
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
      .select('id, external_sku, title, unit_cost_tiyin, unit_cost_source, commission_percent, fulfillment_tiyin, returns_reserve_percent, returns_sample_units, lead_time_days, moq, safety_stock, min_margin_percent, estimated_fields, economics_revision')
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

  if (action === 'sync_now') {
    // The cooldown is claimed in SQL, not checked here: two tabs pressing at the same instant
    // would both pass a read-then-write check in this function.
    const { data: claim, error: claimError } = await admin.rpc('claim_commerce_manual_sync', { p_account: profile.account_id, p_cooldown_seconds: 600 })
    if (claimError) return json({ error: 'could not start the sync' }, 500)
    if (!claim?.ok) {
      if (claim?.reason === 'cooldown') return json({ error: 'cooldown', retry_after_seconds: claim.retry_after_seconds ?? 600 }, 429)
      return json({ error: claim?.reason === 'no_pilot' ? 'commerce pilot is not started' : 'commerce pilot is inactive' }, 409)
    }
    // Same entry point pg_cron uses. It processes whatever is due platform-wide, which is
    // exactly the behaviour that is already load-tested; the cooldown above is what protects
    // this seller's Uzum key from being hammered.
    const response = await fetch(`${URL}/functions/v1/commerce-worker`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'manual' }),
    }).catch(() => null)
    const result = response && response.ok ? await response.json().catch(() => null) : null
    if (!result) return json({ error: 'the sync worker did not respond' }, 502)

    const { data: catalogs } = await admin.from('commerce_catalogs')
      .select('name, last_sync_error').eq('account_id', profile.account_id)
    return json({
      ok: true,
      requeued: claim.requeued ?? 0,
      completed: result.completed ?? 0,
      failed: result.failed ?? 0,
      // Report this account's own catalogues rather than the worker's global counters, which
      // include other tenants' runs and would be misleading here.
      issues: (catalogs ?? []).filter((c: { last_sync_error: string | null }) => c.last_sync_error),
    })
  }

  if (action === 'autofill_economics') {
    // No catalogue id means every catalogue on the account: a seller with four shops should not
    // press the same button four times.
    const targets = body?.catalog_id
      ? [await catalogForAccount(admin, profile.account_id, body.catalog_id)].filter(Boolean)
      : ((await admin.from('commerce_catalogs').select('id').eq('account_id', profile.account_id)).data ?? [])
    if (!targets.length) return json({ error: 'catalog not found' }, 404)
    let cost = 0
    let supply = 0
    const skipped: string[] = []
    for (const target of targets as Array<{ id: string }>) {
      const { data, error } = await userDb.rpc('autofill_commerce_economics', { p_catalog_id: target.id })
      if (error) { skipped.push(target.id); continue }
      cost += Number(data?.cost_estimated ?? 0)
      supply += Number(data?.supply_estimated ?? 0)
    }
    // A catalogue with no completed sync yet cannot be estimated from — say so instead of
    // reporting a silent zero.
    if (skipped.length === targets.length) return json({ error: 'run a catalog sync before auto-filling estimates' }, 409)
    return json({ ok: true, result: { cost_estimated: cost, supply_estimated: supply }, catalogs: targets.length, skipped: skipped.length })
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

  // --- Listing Agent -------------------------------------------------------------------------
  //
  // Nemo does not publish. The Uzum integration is read-only, so this produces a draft the owner
  // copies into their own cabinet. What it adds over writing the listing by hand is that the
  // draft arrives knowing the logistics fee, the commission and the floor price — computed from
  // the same modules Price Guard uses, so a new product cannot be priced by different arithmetic
  // than the ones already selling.

  if (action === 'draft_listing') {
    const sourceText = typeof body?.source_text === 'string' ? body.source_text.trim().slice(0, 4000) : ''
    if (sourceText.length < 10) return json({ error: 'describe the product in at least a sentence' }, 400)

    // Categories, exemplars and margin targets come from the SAME helper the Telegram flow uses —
    // it reads every active catalogue on the account. A per-surface copy of this is what let one
    // surface price a hijab against a catalogue of washing bags.
    // Замок на НОВОЕ действие. Уже собранные черновики остаются читаемыми — list_listing_drafts
    // проверки не делает намеренно: отобрать у владельца его же работу значит потерять его, а не
    // продать ему подписку.
    const access = await entitlementFor(admin, profile.account_id)
    if (!access.allowed) return json({ error: 'subscription_required', reason: access.reason, message: lockMessage(access) }, 402)

    const context = await catalogueContext(admin, profile.account_id)
    if (!context.hasCatalogue) return json({ error: 'connect a catalogue first — the commission comes from categories you already sell in' }, 409)

    // An explicit choice from the owner always wins over the match.
    const chosen = text(body?.uzum_category, 160)
    const candidates = categoryCandidates(sourceText, context.options, context.exemplars)
    const category = chosen
      ? context.options.find((option) => option.category === chosen) ?? null
      : (candidates.confident ? candidates.options[0] : null)

    // ЧИСЛА БЕРУТСЯ ИЗ ИСХОДНОГО ТЕКСТА, а не из объединённого с увиденным.
    //
    // Разбор фотографии уже выбрасывает всё измеримое, но полагаться на одну преграду там, где
    // ошибка портит тариф логистики и каждую минимальную цену по товару, — плохая ставка. Здесь
    // стоит вторая: числу неоткуда взяться, потому что оно читается из слов владельца.
    const numbers = extractNumbers(sourceText)
    const economics = draftEconomics({
      dimension: numbers.dimension,
      unitCostTiyin: numbers.unitCostTiyin,
      category,
      minMarginPercent: category?.min_margin_percent ?? context.defaultMinMargin,
    })

    // The copy is optional on purpose: a model outage must not cost the owner the economics,
    // which is the half of this that no model produced.
    const apiKey = await resolveOpenRouterKey(admin, profile.account_id, Deno.env.get('OPENROUTER_API_KEY') ?? '')

    // Фотографии: подписываются на минуты и уходят модели. Владелец грузит их в приватный бакет
    // сам, сюда приезжают только пути — и каждый проверяется на принадлежность его аккаунту,
    // потому что читаем мы сервисным ключом, которому доступно всё.
    const imageUrls = await signImages(admin, profile.account_id, body?.image_paths)
    const vision = apiKey && imageUrls.length ? await generateVision(apiKey, PRIMARY_MODEL, imageUrls) : null
    // Увиденное дополняет ТЕКСТ для прозы. Числа выше уже посчитаны и сюда не смотрят.
    const copyText = mergeVisionIntoSource(sourceText, vision)
    const copy = apiKey ? await generateCopy(apiKey, PRIMARY_MODEL, copyText) : null

    const { data: draft, error } = await admin.from('commerce_listing_drafts').insert({
      account_id: profile.account_id,
      catalog_id: category?.catalog_id ?? null,
      source_text: sourceText,
      title_ru: copy?.title_ru ?? null,
      title_uz: copy?.title_uz ?? null,
      description_ru: copy?.description_ru ?? null,
      description_uz: copy?.description_uz ?? null,
      attributes: copy?.attributes ?? [],
      // То, что зрение НЕ ИМЕЛО ПРАВА утверждать, приезжает сюда вопросом: габарит и вес, которые
      // модель попыталась назвать по фотографии, становятся строкой «не хватает», а не тишиной.
      unknown_attributes: [...new Set([...(copy?.unknown_attributes ?? []), ...(vision?.unknown_attributes ?? [])])].slice(0, 20),
      uzum_category: category?.category ?? null,
      commission_percent: economics.commission_percent,
      returns_reserve_percent: economics.returns_reserve_percent,
      length_mm: numbers.dimension?.length ?? null,
      width_mm: numbers.dimension?.width ?? null,
      height_mm: numbers.dimension?.height ?? null,
      weight_g: numbers.dimension?.weight ?? null,
      fulfillment_tiyin: economics.fulfillment_tiyin,
      unit_cost_tiyin: economics.unit_cost_tiyin,
      min_margin_percent: economics.min_margin_percent,
      min_selling_price_tiyin: economics.min_selling_price_tiyin,
      missing: economics.missing,
      evidence: numbers.evidence,
      created_by: user.id,
    }).select('*').single()
    if (error) return json({ error: 'could not store the draft' }, 500)

    return json({
      ok: true,
      draft,
      copy_available: Boolean(copy),
      // Returned whenever the match was not confident, so the owner picks instead of Nemo guessing.
      category_choices: category ? [] : candidates.options,
      volume_litres: economics.volume_litres,
      fulfillment_basis: economics.fulfillment_basis,
    })
  }

  if (action === 'accept_finding') {
    // «Принимаю» — обязательство владельца, а не команда маркетплейсу: Nemo по-прежнему ничего
    // не пишет в Uzum. С этого момента совет становится проверяемой гипотезой — база в одной
    // транзакции меняет статус и регистрирует решение с измеримым ожиданием и сроком.
    //
    // Одной транзакцией потому, что принятая рекомендация без решения необучаема и молчит об
    // этом: советы остались бы одинаково хорошими навсегда.
    const recommendationId = String(body?.recommendation_id ?? '')
    if (!UUID.test(recommendationId)) return json({ error: 'invalid_recommendation_id' }, 400)
    const { data, error } = await admin.rpc('commerce_accept_finding', {
      p_account_id: profile.account_id,
      p_recommendation_id: recommendationId,
    })
    if (error) return json({ error: 'accept_failed', detail: error.message }, 500)
    return json({ ok: Boolean(data?.ok), result: data })
  }

  if (action === 'list_findings') {
    // Everything the worker concluded, for the screen where the owner can act on it. Until now
    // these existed only in the database and the Telegram digest: the page showed the inputs and
    // hid the conclusions.
    const { data: catalogs } = await admin.from('commerce_catalogs').select('id').eq('account_id', profile.account_id)
    const catalogIds = (catalogs ?? []).map((row: { id: string }) => row.id)
    if (!catalogIds.length) return json({ ok: true, findings: [], counts: {} })

    const { data: skus } = await admin.from('commerce_skus').select('id, title, external_sku').in('catalog_id', catalogIds)
    const byId = new Map((skus ?? []).map((sku: Record<string, unknown>) => [sku.id, sku]))
    if (!byId.size) return json({ ok: true, findings: [], counts: {} })

    const { data: rows, error } = await admin.from('commerce_recommendations')
      .select('id, kind, severity, calculation, suggested_action, sku_id, last_detected_at')
      .eq('status', 'open').in('sku_id', [...byId.keys()])
      .order('severity', { ascending: true }).order('last_detected_at', { ascending: false }).limit(400)
    if (error) return json({ error: 'could not load findings' }, 500)

    const counts: Record<string, number> = {}
    const findings = (rows ?? []).map((row: Record<string, unknown>) => {
      const key = `${row.kind}:${row.severity}`
      counts[key] = (counts[key] ?? 0) + 1
      const sku = byId.get(row.sku_id) as Record<string, unknown> | undefined
      return { ...row, title: sku?.title ?? '', external_sku: sku?.external_sku ?? '' }
    })
    return json({ ok: true, findings, counts })
  }

  if (action === 'list_listing_drafts') {
    const { data: drafts, error } = await admin.from('commerce_listing_drafts')
      .select('*').eq('account_id', profile.account_id).neq('status', 'discarded')
      .order('created_at', { ascending: false }).limit(50)
    if (error) return json({ error: 'could not load drafts' }, 500)
    // Полки едут вместе со списком, а не только в ответе на генерацию. Черновик без категории
    // живёт дольше одного ответа: после перезагрузки страницы выбирать было бы не из чего, и
    // единственным способом добраться до комиссии снова стала бы повторная генерация.
    const context = await catalogueContext(admin, profile.account_id)
    const names = [...new Set([
      ...context.options.map((option) => option.category),
      ...(drafts ?? []).map((row: Record<string, unknown>) => row.uzum_category).filter((name): name is string => typeof name === 'string'),
    ])]
    const labels = await resolveCategoryLabels(admin, names)
    return json({ ok: true, drafts: drafts ?? [], categories: context.options, category_labels: labels })
  }

  if (action === 'set_listing_category') {
    // Категория выбирается для СУЩЕСТВУЮЩЕГО черновика, без повторной генерации.
    //
    // Раньше выбор из списка влиял только на следующую генерацию: владелец, увидев прочерки
    // вместо комиссии, выбирал полку — и терял весь написанный текст, потому что единственный
    // способ применить выбор был написать описание заново. Полка меняет не текст, а арифметику:
    // комиссию, резерв на возвраты и минимальную цену. Модель здесь не нужна и не вызывается.
    if (typeof body?.draft_id !== 'string' || !UUID.test(body.draft_id)) return json({ error: 'invalid draft_id' }, 400)
    const chosen = text(body?.uzum_category, 160)
    if (!chosen) return json({ error: 'invalid category' }, 400)

    const { data: draft } = await admin.from('commerce_listing_drafts')
      .select('id, source_text, status')
      .eq('id', body.draft_id).eq('account_id', profile.account_id).maybeSingle()
    if (!draft) return json({ error: 'draft not found' }, 404)
    // Одобренный черновик уже перенесён в кабинет. Пересчёт минимальной цены под ним изменил бы
    // число, по которому владелец уже принял решение, — и сделал бы это молча.
    if (draft.status !== 'draft') return json({ error: 'draft already decided' }, 409)

    const context = await catalogueContext(admin, profile.account_id)
    // Полка либо своя (комиссию назвал Uzum), либо названная владельцем. Третьего не бывает, и
    // различие не косметическое: от него зависит, факт перед нами или чужое утверждение.
    const known = context.options.find((option) => option.category === chosen)
    const manual = known ? null : manualCategory({
      category: chosen,
      commissionPercent: body?.commission_percent,
      returnsReservePercent: body?.returns_reserve_percent,
      minMarginPercent: context.defaultMinMargin,
    })
    if (!known && !manual) return json({ error: 'invalid_manual_fees' }, 400)
    const category = known ?? manual!
    const ownerStated = known ? [] : [...OWNER_STATED_FEE_FIELDS]

    // Числа берутся из исходного текста владельца тем же разбором, что и при генерации: цифра,
    // однажды вытащенная из его слов, не должна зависеть от того, в какой момент её перечитали.
    const numbers = extractNumbers(String(draft.source_text ?? ''))
    const economics = draftEconomics({
      dimension: numbers.dimension,
      unitCostTiyin: numbers.unitCostTiyin,
      category,
      minMarginPercent: category.min_margin_percent ?? context.defaultMinMargin,
    })

    const { data: updated, error } = await admin.from('commerce_listing_drafts')
      .update({
        catalog_id: category.catalog_id ?? null,
        uzum_category: category.category,
        commission_percent: economics.commission_percent,
        returns_reserve_percent: economics.returns_reserve_percent,
        fulfillment_tiyin: economics.fulfillment_tiyin,
        min_margin_percent: economics.min_margin_percent,
        min_selling_price_tiyin: economics.min_selling_price_tiyin,
        missing: economics.missing,
        // Перезаписывается, а не дополняется: владелец мог сначала назвать комиссию руками, потом
        // выбрать настоящую полку — и тогда пометка «названо владельцем» обязана исчезнуть.
        owner_stated_fields: ownerStated,
        updated_at: new Date().toISOString(),
      })
      .eq('id', body.draft_id).eq('account_id', profile.account_id).eq('status', 'draft')
      .select('*').maybeSingle()
    if (error || !updated) return json({ error: 'could not apply the category' }, 500)
    return json({ ok: true, draft: updated, volume_litres: economics.volume_litres, fulfillment_basis: economics.fulfillment_basis })
  }

  if (action === 'approve_listing_draft' || action === 'discard_listing_draft') {
    if (typeof body?.draft_id !== 'string' || !UUID.test(body.draft_id)) return json({ error: 'invalid draft_id' }, 400)
    const approving = action === 'approve_listing_draft'
    // Approving means "this text is mine to publish", not "Nemo published it". Nothing leaves the
    // platform on this call, and a draft still missing its economics cannot be approved at all —
    // approving a listing with no floor price is how a product gets sold below cost.
    if (approving) {
      const { data: existing } = await admin.from('commerce_listing_drafts')
        .select('missing').eq('id', body.draft_id).eq('account_id', profile.account_id).maybeSingle()
      if (!existing) return json({ error: 'draft not found' }, 404)
      if (Array.isArray(existing.missing) && existing.missing.length) {
        return json({ error: 'draft still missing inputs', missing: existing.missing }, 409)
      }
    }
    const { data: updated, error } = await admin.from('commerce_listing_drafts')
      .update(approving
        ? { status: 'ready', approved_by: user.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString() }
        : { status: 'discarded', updated_at: new Date().toISOString() })
      .eq('id', body.draft_id).eq('account_id', profile.account_id).eq('status', 'draft')
      .select('id, status').maybeSingle()
    if (error) return json({ error: 'could not update the draft' }, 500)
    if (!updated) return json({ error: 'draft not found or already decided' }, 409)

    // «Полная автономия»: одобренная карточка уходит на модерацию сама, без второго нажатия.
    // Автономия решает КОГДА отправить одобренное, а не отменяет одобрение — поэтому она висит
    // здесь, после approve, а не вместо него.
    if (approving) {
      const { data: pilot } = await admin.from('commerce_pilots')
        .select('auto_submit_to_moderation').eq('account_id', profile.account_id).maybeSingle()
      if (pilot?.auto_submit_to_moderation !== false) {
        const attempt = await submitDraft(admin, {
          draftId: body.draft_id, accountId: profile.account_id, userId: user.id, mode: 'auto', lang,
        })
        return json({ ok: true, draft: updated, submission: attempt })
      }
    }
    return json({ ok: true, draft: updated })
  }

  // Режим отправки. Тумблер показывается при первом запуске, а не обнаруживается потом по факту
  // уехавшей карточки.
  //
  // Тумблеров ДВА, и они не связаны. Официальный API живёт по договору с площадкой; расширение
  // работает вашей сессией в кабинете и, вероятно, противоречит правилам продавца Uzum. Один
  // переключатель на оба означал бы, что включивший автономию по API незаметно включил и
  // автоматизацию кабинета.
  if (action === 'set_auto_submit') {
    const enabled = body?.enabled === true
    const column = body?.channel === 'extension' ? 'auto_extension_submit' : 'auto_submit_to_moderation'
    const { error } = await admin.from('commerce_pilots')
      .update({ [column]: enabled }).eq('account_id', profile.account_id)
    if (error) return json({ error: 'could not change the submit mode' }, 500)
    return json({ ok: true, [column]: enabled })
  }

  // План действий для браузерного агента.
  //
  // Расширение присылает снимок страницы и поручение, получает список действий. Ни одного решения
  // о том, что нажать, расширение не принимает само — и ни одному ответу модели не верит на слово:
  // checkPlan сверяет каждый номер со снимком, который сам же и прислал.
  if (action === 'agent_plan') {
    const access = await entitlementFor(admin, profile.account_id)
    if (!access.allowed) return json({ error: 'subscription_required', reason: access.reason, message: lockMessage(access) }, 402)

    const items = Array.isArray(body?.page?.items) ? body.page.items.slice(0, 150) : []
    if (!items.length) return json({ error: 'empty_page' }, 400)
    const instruction = typeof body?.instruction === 'string' ? body.instruction.trim().slice(0, 500) : ''
    if (!instruction) return json({ error: 'no_instruction' }, 400)

    // Данные для подстановки берутся НА СЕРВЕРЕ, а не из поручения: иначе достаточно попросить
    // «впиши сюда чужой артикул», и расширение впишет что угодно, что уместилось в текст.
    const { data: draft } = await admin.from('commerce_listing_drafts')
      .select('id, title_ru, title_uz, description_ru, description_uz, uzum_category, min_selling_price_tiyin')
      .eq('account_id', profile.account_id).eq('status', 'ready')
      .order('approved_at', { ascending: true }).limit(1).maybeSingle()

    // Без третьего аргумента resolveOpenRouterKey отдаёт undefined всем, у кого нет своего ключа
    // OpenRouter в настройках, — а это почти все: план всегда работает на общем платформенном
    // ключе, если владелец не подключил свой. Так и получилось «llm_not_configured» на живом
    // аккаунте: ключ на сервере есть, просто сюда он не доезжал.
    const apiKey = await resolveOpenRouterKey(admin, profile.account_id, Deno.env.get('OPENROUTER_API_KEY') ?? '')
    if (!apiKey) return json({ error: 'llm_not_configured' }, 409)

    const answer = await callOpenRouter({
      apiKey,
      model: PRIMARY_MODEL,
      temperature: 0,
      maxTokens: 2000,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        {
          role: 'user',
          content: planUserPrompt({
            instruction,
            page: { url: body?.page?.url, title: body?.page?.title, items },
            data: draft
              ? {
                title_ru: draft.title_ru, title_uz: draft.title_uz,
                description_ru: draft.description_ru, description_uz: draft.description_uz,
                category: draft.uzum_category,
                price_uzs: draft.min_selling_price_tiyin == null ? null : Math.ceil(draft.min_selling_price_tiyin / 100),
              }
              : null,
          }),
        },
      ],
    }).catch(() => null)
    if (!answer) return json({ error: 'llm_unavailable' }, 502)

    let parsed: unknown = null
    try { parsed = JSON.parse(stripJsonFence(answer.content)) } catch { parsed = null }
    const checked = checkPlan(parsed, items)

    return json({
      ok: true,
      actions: checked.actions,
      // Отброшенное называется, а не исчезает: молчаливая фильтрация превращает разбор в гадание.
      rejected: checked.rejected,
      note: planNote(parsed),
      draft_id: draft?.id ?? null,
    })
  }

  // Следующая карточка для расширения. Пусто — это не ошибка, а «работы нет».
  //
  // Отдаётся ровно то, что расширение вставит в форму: ни ключей, ни внутренних идентификаторов
  // чужих сущностей. Расширение работает в чужом кабинете, и лишнее поле в его памяти — это
  // лишнее поле, которое может утечь вместе с ним.
  if (action === 'next_extension_task') {
    const access = await entitlementFor(admin, profile.account_id)
    if (!access.allowed) return json({ error: 'subscription_required', reason: access.reason, message: lockMessage(access) }, 402)

    const { data: draft } = await admin.from('commerce_listing_drafts')
      .select('id, title_ru, title_uz, description_ru, description_uz, uzum_category, attributes, min_selling_price_tiyin')
      .eq('account_id', profile.account_id).eq('status', 'ready')
      .order('approved_at', { ascending: true }).limit(1).maybeSingle()
    if (!draft) return json({ ok: true, task: null })

    return json({
      ok: true,
      task: {
        id: draft.id,
        title_ru: draft.title_ru, title_uz: draft.title_uz,
        description_ru: draft.description_ru, description_uz: draft.description_uz,
        category: draft.uzum_category,
        attributes: draft.attributes ?? [],
        // Цена в сумах: в форме кабинета она в сумах, и пересчёт на стороне расширения означал бы
        // вторую копию арифметики — ту, что однажды разойдётся с первой.
        price: draft.min_selling_price_tiyin == null ? null : Math.ceil(draft.min_selling_price_tiyin / 100),
      },
    })
  }

  // Исход попытки расширения — в тот же журнал, что и попытки через API.
  //
  // Успех записывает РАСШИРЕНИЕ, и это единственное место, где мы верим ему на слово: сервер не
  // видит кабинет и проверить отправку не может. Поэтому 'sent' здесь означает «расширение
  // нажало кнопку», и статус черновика меняется вместе с ним — а настоящее подтверждение придёт
  // синхронизацией, когда товар появится в каталоге.
  if (action === 'report_extension_result') {
    if (typeof body?.draft_id !== 'string' || !UUID.test(body.draft_id)) return json({ error: 'invalid draft_id' }, 400)
    const status = body?.status === 'sent' || body?.status === 'refused' || body?.status === 'failed' ? body.status : 'failed'

    const { data: draft } = await admin.from('commerce_listing_drafts')
      .select('id').eq('id', body.draft_id).eq('account_id', profile.account_id).maybeSingle()
    if (!draft) return json({ error: 'draft not found' }, 404)

    await admin.from('commerce_listing_submissions').insert({
      draft_id: body.draft_id, account_id: profile.account_id,
      mode: body?.mode === 'auto' ? 'auto' : 'manual',
      transport: 'extension',
      status,
      reason: typeof body?.reason === 'string' ? body.reason.slice(0, 60) : null,
      owner_message: typeof body?.message === 'string' ? body.message.slice(0, 600) : null,
      external_product_id: typeof body?.external_product_id === 'string' ? body.external_product_id.slice(0, 120) : null,
      attempted_by: user.id,
    })

    if (status === 'sent') {
      await admin.from('commerce_listing_drafts')
        .update({ status: 'submitted', submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', body.draft_id).eq('account_id', profile.account_id).eq('status', 'ready')
    }
    return json({ ok: true })
  }

  // Ручная отправка. Та же дорога, что у автономии, — иначе два пути разошлись бы, и «Отправить»
  // вручную начало бы проверять не то, что проверяет автомат.
  if (action === 'submit_listing') {
    if (typeof body?.draft_id !== 'string' || !UUID.test(body.draft_id)) return json({ error: 'invalid draft_id' }, 400)
    const attempt = await submitDraft(admin, {
      draftId: body.draft_id, accountId: profile.account_id, userId: user.id, mode: 'manual', lang,
    })
    return json({ ok: attempt.status === 'sent', submission: attempt }, attempt.status === 'sent' ? 200 : 409)
  }

  // Журнал попыток по карточке. Владелец вправе видеть, что именно ответила площадка.
  if (action === 'list_submissions') {
    const query = admin.from('commerce_listing_submissions')
      .select('id, draft_id, mode, transport, status, http_status, reason, owner_message, provider_response, external_product_id, created_at')
      .eq('account_id', profile.account_id).order('created_at', { ascending: false }).limit(50)
    const { data, error } = typeof body?.draft_id === 'string' && UUID.test(body.draft_id)
      ? await query.eq('draft_id', body.draft_id)
      : await query
    if (error) return json({ error: 'could not load submissions' }, 500)
    return json({ ok: true, submissions: data ?? [] })
  }

  return json({ error: 'unknown action' }, 400)
})
