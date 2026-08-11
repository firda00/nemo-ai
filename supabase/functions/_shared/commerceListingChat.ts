// Listing Agent in the owner's Telegram chat.
//
// Same pipeline as /app/commerce, same modules, same refusals — only the surface changes. The
// owner dictates or types a new product; a draft comes back knowing its logistics fee, its
// commission and the price below which it loses money. Nothing is written to Uzum, here or
// anywhere: approving means "this text is mine to paste", and the schema has no other meaning.
//
// The trigger is EXPLICIT. "Себестоимость 18000" about an existing SKU and "новый товар,
// себестоимость 18000" are the same sentence to a classifier, and guessing wrong either edits a
// product the owner did not mean or buries a new one in a table. A prefix costs one word and is
// never ambiguous — including when it arrives as a transcribed voice note, which is why the
// spoken forms are accepted alongside the slash command.
import {
  categoryCandidates,
  draftEconomics,
  extractNumbers,
  generateCopy,
  type CategoryOption,
} from './listingDraft.ts'
import { escapeHtml } from './telegramFormat.ts'
import { signImages } from './listingImages.ts'
import { generateVision, mergeVisionIntoSource } from './listingVision.ts'
import type { OwnerChat } from './commerceEconomicsChat.ts'

export const CB_LISTING = 'cld'
export const CB_LISTING_CATEGORY = 'clc'

/**
 * Telegram caps callback_data at 64 BYTES. "clc:" plus a uuid is already 40, and a category named
 * "Roʻmol uchun muftalar va halqalar" pushes it to 74 — the button would arrive truncated and
 * match nothing. An index would fit but is not stable: the list is re-derived on the press and
 * re-sorted by match score, so position 2 need not still mean the same shelf.
 *
 * A hash of the name is both short and stable. FNV-1a over the UTF-16 units, eight hex digits.
 */
export function categoryToken(category: string): string {
  let hash = 0x811c9dc5
  const value = String(category ?? '')
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

// `\b` would be wrong here for the same reason it was wrong in the weight parser: JS defines it
// over [A-Za-z0-9_], so after the Cyrillic "р" of "товар" there is no boundary and every Russian
// trigger silently failed. A lookahead for "not a letter or digit" is what was meant, and it still
// refuses "новый товарищ" — which is the whole point of having a boundary.
const TRIGGER = /^\s*(?:\/new(?:@\w+)?|новый\s+товар|новая\s+позиция|yangi\s+mahsulot|yangi\s+tovar)(?![\p{L}\p{N}])[\s,:.—-]*/iu

/** The owner said "new product" and then described one. Returns the description, or null. */
export function newListingText(text: string): string | null {
  const raw = String(text ?? '')
  if (!TRIGGER.test(raw)) return null
  const description = raw.replace(TRIGGER, '').trim()
  return description.length >= 10 ? description : ''
}

export const NEW_LISTING_HELP = [
  '🆕 <b>Новый товар</b>',
  '',
  'Опишите товар одним сообщением — текстом или голосом. Чем больше фактов, тем полнее черновик:',
  '',
  '<code>новый товар: женский хиджаб-бони из шифона, молочный, упаковка 238x138x34 мм, вес 120 г, себестоимость 18000 сум</code>',
  '',
  'Габариты и себестоимость нужны, чтобы посчитать минимальную цену. Без габаритов Uzum берёт максимальный тариф 50 000 сум — так и посчитаю.',
  '',
  // Сказано прямо, потому что иначе владелец приложит снимок и будет ждать, что размеры
  // заполнятся сами. По фотографии их не видно, и придумывать их система не станет.
  '📷 Можно приложить фотографию — подписью к ней. По снимку я определю вид, цвет, узор и материал.',
  'Габариты, вес и себестоимость с фотографии не берутся: их там не видно. Пишите их текстом.',
  'Альбом Telegram присылает по одному сообщению на снимок, поэтому в работу идёт то фото, под которым написан текст.',
].join('\n')

export type DraftRow = {
  id: string
  title_ru: string | null
  title_uz: string | null
  description_ru: string | null
  uzum_category: string | null
  commission_percent: number | null
  length_mm: number | null
  width_mm: number | null
  height_mm: number | null
  weight_g: number | null
  fulfillment_tiyin: number | null
  unit_cost_tiyin: number | null
  min_margin_percent: number | null
  min_selling_price_tiyin: number | null
  missing: string[] | null
  unknown_attributes: string[] | null
  evidence: string[] | null
}

const MISSING_LABEL: Record<string, string> = {
  dimensions: 'габариты (длина × ширина × высота)',
  unit_cost: 'себестоимость',
  category: 'категория',
}

const uzs = (tiyin: number | null | undefined) =>
  tiyin == null ? '—' : `${Math.round(tiyin / 100).toLocaleString('ru-RU')} сум`

/** The card. Every number on it is either a fact or an explicit gap — never a filled-in guess. */
export function draftCard(draft: DraftRow): string {
  const missing = draft.missing ?? []
  const lines = [
    `🆕 <b>${escapeHtml(draft.title_ru ?? 'Черновик без названия')}</b>`,
  ]
  if (draft.title_uz) lines.push(`<i>${escapeHtml(draft.title_uz)}</i>`)
  if (draft.description_ru) lines.push('', escapeHtml(draft.description_ru))

  lines.push('', '<b>Экономика</b>')
  lines.push(`• Категория: ${draft.uzum_category ? escapeHtml(draft.uzum_category) : '—'}`)
  lines.push(`• Комиссия Uzum: ${draft.commission_percent == null ? '—' : `${Number(draft.commission_percent)}%`}`)
  const dimensions = draft.length_mm && draft.width_mm && draft.height_mm
    ? `${draft.length_mm}×${draft.width_mm}×${draft.height_mm} мм`
    : 'не указаны'
  lines.push(`• Габариты: ${dimensions}`)
  // The fee is stated with its reason: 50 000 without dimensions is the real tariff, not a penalty
  // Nemo invented, and the owner is the only one who can change it.
  lines.push(`• Логистика: ${uzs(draft.fulfillment_tiyin)}${missing.includes('dimensions') ? ' — тариф «без ВГХ»' : ''}`)
  lines.push(`• Себестоимость: ${uzs(draft.unit_cost_tiyin)}`)
  lines.push(
    draft.min_selling_price_tiyin == null
      ? '• <b>Минимальная цена: нечем считать</b>'
      : `• <b>Минимальная цена: ${uzs(draft.min_selling_price_tiyin)}</b> (маржа ${Number(draft.min_margin_percent ?? 0)}%)`,
  )

  if (missing.length) {
    lines.push('', `⚠️ <b>Не хватает:</b> ${missing.map((field) => MISSING_LABEL[field] ?? field).join(', ')}`)
    lines.push('Пришлите недостающее одним сообщением — соберу заново.')
  }
  if ((draft.unknown_attributes ?? []).length) {
    lines.push('', `📋 Ещё стоит указать: ${(draft.unknown_attributes ?? []).map((name) => escapeHtml(name)).join(', ')}`)
  }
  if ((draft.evidence ?? []).length) {
    lines.push('', `<i>Цифры взяты из: ${(draft.evidence ?? []).map((piece) => escapeHtml(piece)).join(' | ')}</i>`)
  }
  if (!missing.length) lines.push('', 'Nemo ничего не публикует на Uzum — одобрение значит, что текст готов к переносу вручную.')
  return lines.join('\n')
}

/**
 * Buttons follow what the draft can honestly offer.
 *
 * A category is one tap, so when that is the only gap the shelves are offered directly. Dimensions
 * and cost cannot be supplied by a button, so none is shown that pretends otherwise — the card
 * says what to send instead. Approval appears only when nothing is missing.
 */
export function draftKeyboard(draft: DraftRow, categories: CategoryOption[]) {
  const missing = draft.missing ?? []
  const rows: Array<Array<{ text: string; callback_data: string }>> = []

  if (missing.includes('category') && categories.length) {
    for (const option of categories.slice(0, 6)) {
      rows.push([{
        text: `${option.category} · ${option.commission_percent}%`.slice(0, 60),
        callback_data: `${CB_LISTING_CATEGORY}:${draft.id}:${categoryToken(option.category)}`,
      }])
    }
  }
  rows.push(missing.length
    ? [{ text: '✖️ Убрать черновик', callback_data: `${CB_LISTING}:${draft.id}:n` }]
    : [
      { text: '✅ Одобрить', callback_data: `${CB_LISTING}:${draft.id}:y` },
      { text: '✖️ Убрать', callback_data: `${CB_LISTING}:${draft.id}:n` },
    ])
  return { inline_keyboard: rows }
}

/**
 * Categories the seller already sells in, across EVERY active catalogue, plus their own product
 * names to match against.
 *
 * Every catalogue, not one. The first version asked for the oldest active catalogue and stopped
 * there — and this seller's four shops were all discovered in the same second, so the tie was
 * broken arbitrarily by Postgres. A hijab got priced against a catalogue of three washing bags at
 * 20% commission while the 110 hijab SKUs sat in a catalogue the code never opened.
 *
 * A category can exist in more than one shop; it is attributed to the one carrying the most SKUs
 * in it, because that is where the commission evidence is strongest.
 */
export async function catalogueContext(db: any, accountId: string): Promise<{
  hasCatalogue: boolean
  defaultMinMargin: number
  options: CategoryOption[]
  exemplars: Array<{ text: string; category: string }>
}> {
  const { data: catalogs } = await db.from('commerce_catalogs')
    .select('id, default_min_margin_percent').eq('account_id', accountId).eq('status', 'active')
  if (!catalogs?.length) return { hasCatalogue: false, defaultMinMargin: 20, options: [], exemplars: [] }

  const marginByCatalog = new Map<string, number>(
    catalogs.map((row: Record<string, unknown>) => [String(row.id), Number(row.default_min_margin_percent ?? 20)]),
  )
  const { data: rows } = await db.from('commerce_skus')
    .select('catalog_id, uzum_category, commission_percent, returns_reserve_percent, title, external_sku')
    .in('catalog_id', catalogs.map((row: Record<string, unknown>) => row.id))
    .not('uzum_category', 'is', null).not('commission_percent', 'is', null)

  // Commission and returns are pooled per category; the catalogue is decided by SKU count within it.
  const byCategory = new Map<string, { commission: number[]; returns: number[]; catalogs: Map<string, number> }>()
  for (const row of rows ?? []) {
    const bucket = byCategory.get(row.uzum_category) ?? { commission: [], returns: [], catalogs: new Map<string, number>() }
    bucket.commission.push(Number(row.commission_percent))
    if (row.returns_reserve_percent != null) bucket.returns.push(Number(row.returns_reserve_percent))
    bucket.catalogs.set(row.catalog_id, (bucket.catalogs.get(row.catalog_id) ?? 0) + 1)
    byCategory.set(row.uzum_category, bucket)
  }
  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null)

  const options: CategoryOption[] = [...byCategory.entries()].map(([category, bucket]) => {
    const [catalogId] = [...bucket.catalogs.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    return {
      category,
      commission_percent: Number((mean(bucket.commission) ?? 0).toFixed(4)),
      returns_reserve_percent: bucket.returns.length ? Number(mean(bucket.returns)!.toFixed(4)) : null,
      skus: bucket.commission.length,
      catalog_id: catalogId,
      min_margin_percent: marginByCatalog.get(catalogId) ?? 20,
    }
  })

  // With no category matched there is still a margin target to use: the shop holding most of their
  // catalogue is the defensible default, and ties break on id so the answer never wobbles.
  const skusByCatalog = new Map<string, number>()
  for (const row of rows ?? []) skusByCatalog.set(row.catalog_id, (skusByCatalog.get(row.catalog_id) ?? 0) + 1)
  const biggest = [...skusByCatalog.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]

  return {
    hasCatalogue: true,
    defaultMinMargin: biggest ? marginByCatalog.get(biggest[0]) ?? 20 : 20,
    options,
    exemplars: (rows ?? []).map((row: Record<string, unknown>) => ({
      text: `${row.external_sku ?? ''} ${row.title ?? ''}`,
      category: String(row.uzum_category),
    })),
  }
}

/** The row a draft becomes. Shared with the web action so both surfaces store the same shape. */
export function draftRow(input: {
  accountId: string
  catalogId: string | null
  sourceText: string
  numbers: ReturnType<typeof extractNumbers>
  economics: ReturnType<typeof draftEconomics>
  category: CategoryOption | null
  copy: Awaited<ReturnType<typeof generateCopy>>
}) {
  return {
    account_id: input.accountId,
    catalog_id: input.catalogId,
    source_text: input.sourceText,
    title_ru: input.copy?.title_ru ?? null,
    title_uz: input.copy?.title_uz ?? null,
    description_ru: input.copy?.description_ru ?? null,
    description_uz: input.copy?.description_uz ?? null,
    attributes: input.copy?.attributes ?? [],
    unknown_attributes: input.copy?.unknown_attributes ?? [],
    uzum_category: input.category?.category ?? null,
    commission_percent: input.economics.commission_percent,
    returns_reserve_percent: input.economics.returns_reserve_percent,
    length_mm: input.numbers.dimension?.length ?? null,
    width_mm: input.numbers.dimension?.width ?? null,
    height_mm: input.numbers.dimension?.height ?? null,
    weight_g: input.numbers.dimension?.weight ?? null,
    fulfillment_tiyin: input.economics.fulfillment_tiyin,
    unit_cost_tiyin: input.economics.unit_cost_tiyin,
    min_margin_percent: input.economics.min_margin_percent,
    min_selling_price_tiyin: input.economics.min_selling_price_tiyin,
    missing: input.economics.missing,
    evidence: input.numbers.evidence,
  }
}

/**
 * Builds and stores a draft from one owner message. Returns the stored row plus the categories to
 * offer, or null when there is no catalogue to price against — a commission has to come from
 * somewhere, and a seller with nothing synced has no somewhere.
 */
export async function buildListingDraft(
  db: any,
  apiKey: string,
  owner: OwnerChat,
  sourceText: string,
  /** Пути уже загруженных фотографий в приватном бакете. Пустой список — обычный текстовый путь. */
  imagePaths: string[] = [],
): Promise<{ draft: DraftRow; categories: CategoryOption[] } | null> {
  const context = await catalogueContext(db, owner.accountId)
  if (!context.hasCatalogue) return null

  const numbers = extractNumbers(sourceText)
  const candidates = categoryCandidates(sourceText, context.options, context.exemplars)
  const category = candidates.confident ? candidates.options[0] : null
  const economics = draftEconomics({
    dimension: numbers.dimension,
    unitCostTiyin: numbers.unitCostTiyin,
    category,
    // The matched shelf brings its own shop's margin target with it; without a match, the shop
    // holding most of the catalogue sets it.
    minMarginPercent: category?.min_margin_percent ?? context.defaultMinMargin,
  })
  // ЧИСЛА ВЫШЕ УЖЕ ПОСЧИТАНЫ — из sourceText, слов владельца. Фотография ниже влияет только на
  // прозу: то же разделение, что в веб-пути, и по той же причине. Габарит, угаданный по снимку,
  // ушёл бы в тариф логистики и оттуда в минимальную цену.
  const model = Deno.env.get('PRIMARY_MODEL') ?? 'openai/gpt-4o-mini'
  const imageUrls = imagePaths.length ? await signImages(db, owner.accountId, imagePaths) : []
  const vision = apiKey && imageUrls.length ? await generateVision(apiKey, model, imageUrls) : null
  // The copy is optional: a model outage must not cost the owner the economics, which is the half
  // no model produced.
  const copy = apiKey ? await generateCopy(apiKey, model, mergeVisionIntoSource(sourceText, vision)) : null

  const row = draftRow({ accountId: owner.accountId, catalogId: category?.catalog_id ?? null, sourceText, numbers, economics, category, copy })
  // То, что зрению не разрешили утверждать, приезжает вопросом в «не хватает».
  const { data: draft, error } = await db.from('commerce_listing_drafts')
    .insert({
      ...row,
      unknown_attributes: [...new Set([...(row.unknown_attributes ?? []), ...(vision?.unknown_attributes ?? [])])].slice(0, 20),
    })
    .select('*').single()
  if (error || !draft) return null
  return { draft: draft as DraftRow, categories: candidates.options }
}

/**
 * Applies a category the owner picked and recomputes everything that depends on it.
 *
 * Recomputed, not patched: the floor price is a function of the commission, and writing the new
 * commission next to the old floor would leave a card whose own numbers disagree.
 */
export async function applyCategory(db: any, draft: DraftRow, option: CategoryOption): Promise<DraftRow | null> {
  const economics = draftEconomics({
    dimension: draft.length_mm && draft.width_mm && draft.height_mm
      ? { length: draft.length_mm, width: draft.width_mm, height: draft.height_mm, weight: draft.weight_g }
      : null,
    unitCostTiyin: draft.unit_cost_tiyin,
    category: option,
    // The shelf carries its shop's margin target. Keeping the draft's earlier value would price a
    // product against a target belonging to a different shop.
    minMarginPercent: option.min_margin_percent ?? Number(draft.min_margin_percent ?? 20),
  })
  const { data: updated } = await db.from('commerce_listing_drafts').update({
    uzum_category: option.category,
    catalog_id: option.catalog_id ?? null,
    commission_percent: economics.commission_percent,
    returns_reserve_percent: economics.returns_reserve_percent,
    fulfillment_tiyin: economics.fulfillment_tiyin,
    min_margin_percent: economics.min_margin_percent,
    min_selling_price_tiyin: economics.min_selling_price_tiyin,
    missing: economics.missing,
    updated_at: new Date().toISOString(),
  }).eq('id', draft.id).eq('status', 'draft').select('*').maybeSingle()
  return (updated as DraftRow) ?? null
}
