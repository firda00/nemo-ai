// Filling in the costs Uzum cannot tell us.
//
// 135 of 140 SKUs still carry the placeholder — half of retail — and every one of them holds its
// price alert down to a warning, because an alert resting on a guess must never claim a confirmed
// loss. The single-item dictation flow already works; what it lacks is a shape that survives being
// used 135 times. This adds three things: a "what next" that names the SKUs worth doing first, a
// batch line the owner can dictate in one breath, and a count of what is left.
//
// NO MODEL PARSES THE BATCH. "бони 18000, шарф 22000" is a name and a number, twice — regular
// expressions do that exactly, and a cost is the input that poisons every margin downstream if it
// is quietly rounded or reassigned. The existing single-item path keeps its LLM because it also
// accepts lead times and margins in prose; a batch is only ever names and costs.

import type { SkuCandidate } from './commerceEconomicsChat.ts'
import { escapeHtml } from './telegramFormat.ts'

export const CB_COST_BATCH = 'ccb'

/** One dictated pair, before it is matched to anything. */
export interface CostItem {
  query: string
  costUzs: number
}

export interface ParsedBatch {
  items: CostItem[]
  /** Segments that carried no usable number. Reported back, never guessed at. */
  unparsed: string[]
}

// A cost below this is almost certainly a quantity or a size that wandered into the wrong place.
// Uzbek retail does not have 50-sum goods, and reading "6" from "заколки 6шт" as a cost would put
// a margin of 99% on the table and keep it there.
const MIN_COST_UZS = 100
const MAX_COST_UZS = 100_000_000

// Splits on the separators people actually dictate with: new lines, semicolons, and commas. A
// comma inside a number ("18,5") is protected because the split needs a non-digit on both sides.
const SEGMENT = /\r?\n|;|,(?!\s*\d)|(?<!\d)\s*,\s*/
// The LAST standalone number in a segment is the cost. Names carry digits too — "заколки 6шт
// 9000", "бони 46 размер 18000" — and in every one of them the price is the number said last.
const TRAILING_NUMBER = /(\d[\d\s\u00a0]*)(?:\s*(?:сум|so['‘’]m|uzs|som))?\s*$/i

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()

export function parseCostBatch(text: string): ParsedBatch {
  const items: CostItem[] = []
  const unparsed: string[] = []
  for (const raw of String(text ?? '').split(SEGMENT)) {
    const segment = clean(raw)
    if (!segment) continue
    const hit = segment.match(TRAILING_NUMBER)
    const cost = hit ? Number(hit[1].replace(/[\s\u00a0]/g, '')) : NaN
    const query = hit ? clean(segment.slice(0, hit.index)) : segment
    if (!hit || !Number.isFinite(cost) || cost < MIN_COST_UZS || cost > MAX_COST_UZS || !query) {
      unparsed.push(segment.slice(0, 80))
      continue
    }
    items.push({ query, costUzs: Math.round(cost) })
  }
  return { items, unparsed }
}

/** A batch is two or more costs. One is the existing single-item flow, which also accepts prose. */
export function looksLikeCostBatch(text: string): boolean {
  return parseCostBatch(text).items.length >= 2
}

export type MatchedItem =
  | { kind: 'matched'; item: CostItem; sku: SkuCandidate }
  | { kind: 'ambiguous'; item: CostItem; candidates: SkuCandidate[] }
  | { kind: 'unknown'; item: CostItem }

/**
 * Each dictated cost is matched on its own, and only an exact single match is accepted.
 *
 * Ambiguity is reported, never resolved by picking the first: writing a cost onto the wrong colour
 * is invisible afterwards — the number looks perfectly reasonable sitting on the wrong row, and
 * every margin it feeds is quietly wrong from then on.
 */
export function matchBatch(items: CostItem[], skus: SkuCandidate[], match: (query: string, skus: SkuCandidate[]) => SkuCandidate[]): MatchedItem[] {
  return items.map((item) => {
    const candidates = match(item.query, skus)
    if (candidates.length === 1) return { kind: 'matched', item, sku: candidates[0] }
    if (candidates.length > 1) return { kind: 'ambiguous', item, candidates: candidates.slice(0, 5) }
    return { kind: 'unknown', item }
  })
}

const uzs = (value: number) => `${value.toLocaleString('ru-RU')} сум`

/** The confirmation card. Everything that will be written, and everything that will not. */
export function batchCard(matched: MatchedItem[], unparsed: string[], remaining: number): string {
  const ok = matched.filter((row): row is Extract<MatchedItem, { kind: 'matched' }> => row.kind === 'matched')
  const lines = [`💰 <b>Себестоимость — ${ok.length} из ${matched.length}</b>`, '']

  for (const row of ok) {
    lines.push(`✅ <b>${escapeHtml(row.sku.title)}</b> — ${uzs(row.item.costUzs)}`)
  }
  for (const row of matched) {
    if (row.kind === 'ambiguous') {
      lines.push(`❓ «${escapeHtml(row.item.query)}» — подходит ${row.candidates.length}: ${row.candidates.map((c) => escapeHtml(c.title)).join(', ')}`)
    }
    if (row.kind === 'unknown') lines.push(`🔎 «${escapeHtml(row.item.query)}» — в каталоге не нашёл`)
  }
  for (const segment of unparsed) lines.push(`⚠️ «${escapeHtml(segment)}» — не понял цену`)

  if (matched.some((row) => row.kind !== 'matched') || unparsed.length) {
    lines.push('', 'Непонятые строки не сохраняются. Пришлите их точным названием из каталога.')
  }
  if (ok.length) {
    lines.push('', `После сохранения останется без себестоимости: <b>${Math.max(0, remaining - ok.length)}</b>`)
  }
  return lines.join('\n')
}

export function batchKeyboard(batchKey: string, savable: number) {
  if (!savable) return undefined
  return {
    inline_keyboard: [[
      { text: `✅ Сохранить ${savable}`, callback_data: `${CB_COST_BATCH}:${batchKey}:y` },
      { text: '✖️ Отмена', callback_data: `${CB_COST_BATCH}:${batchKey}:n` },
    ]],
  }
}

export interface CostTarget {
  title: string
  external_sku: string
  price_uzs: number | null
  stock: number | null
}

/**
 * What to price next, and the card that asks for it.
 *
 * Ordered by the money standing on the shelf — retail price times stock. A wrong cost on the
 * deepest inventory distorts the most, and those are also the SKUs whose margin the owner is most
 * likely to care about being right.
 */
export function nextCard(targets: CostTarget[], remaining: number): string {
  if (!remaining) {
    return [
      '🎉 <b>Себестоимость заполнена везде.</b>',
      '',
      'Каждый ценовой алерт теперь стоит на ваших числах, а не на оценке Nemo.',
    ].join('\n')
  }
  const lines = [
    `💰 <b>Осталось без себестоимости: ${remaining}</b>`,
    '',
    'Начните с этих — на них лежит больше всего денег:',
    '',
  ]
  for (const target of targets) {
    const parts = [`• <b>${escapeHtml(target.title)}</b>`]
    if (target.price_uzs != null) parts.push(`цена ${uzs(target.price_uzs)}`)
    if (target.stock != null) parts.push(`остаток ${target.stock}`)
    lines.push(parts.join(' — '))
  }
  lines.push(
    '',
    'Пришлите одним сообщением, через запятую или с новой строки:',
    `<code>${escapeHtml(targets[0]?.title ?? 'название')} 18000, ${escapeHtml(targets[1]?.title ?? 'другое название')} 22000</code>`,
    '',
    'Можно голосом. Сохраню только после вашего подтверждения.',
  )
  return lines.join('\n')
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * SKUs still on the placeholder cost, deepest inventory first.
 *
 * "Still on the placeholder" means the cost is an ESTIMATE — a value the owner stated, or one Uzum
 * confirmed on a real sale, is already the truth and must never be asked for again.
 */
export async function costCampaignState(db: any, accountId: string, take = 5): Promise<{ remaining: number; targets: CostTarget[] }> {
  const { data: catalogs } = await db.from('commerce_catalogs')
    .select('id').eq('account_id', accountId).eq('status', 'active')
  const catalogIds = (catalogs ?? []).map((row: Record<string, unknown>) => row.id)
  if (!catalogIds.length) return { remaining: 0, targets: [] }

  const { data: skus } = await db.from('commerce_skus')
    .select('id, title, external_sku, estimated_fields')
    .in('catalog_id', catalogIds)
  const pending = (skus ?? []).filter((sku: Record<string, unknown>) =>
    Array.isArray(sku.estimated_fields) && (sku.estimated_fields as string[]).includes('unit_cost_tiyin'))
  if (!pending.length) return { remaining: 0, targets: [] }

  // Latest observation per SKU, so "most money on the shelf" is measured against what is there now.
  const { data: snapshots } = await db.from('commerce_inventory_snapshots')
    .select('sku_id, price_tiyin, stock_total, observed_slot')
    .in('sku_id', pending.map((sku: Record<string, unknown>) => sku.id))
    .order('observed_slot', { ascending: false })
  const latest = new Map<string, { price_tiyin: number | null; stock_total: number | null }>()
  for (const row of snapshots ?? []) if (!latest.has(row.sku_id)) latest.set(row.sku_id, row)

  const targets = pending
    .map((sku: Record<string, unknown>) => {
      const observation = latest.get(String(sku.id))
      const price = observation?.price_tiyin == null ? null : Math.round(observation.price_tiyin / 100)
      const stock = observation?.stock_total ?? null
      return {
        title: String(sku.title),
        external_sku: String(sku.external_sku),
        price_uzs: price,
        stock,
        // Money standing on the shelf. A wrong cost here distorts the most, and a SKU with no
        // stock and no price sorts last rather than being dropped — it still needs a cost.
        weight: (price ?? 0) * (stock ?? 0),
      }
    })
    .sort((a, b) => b.weight - a.weight || (b.price_uzs ?? 0) - (a.price_uzs ?? 0))
    .slice(0, take)
    .map(({ weight: _weight, ...target }) => target)

  return { remaining: pending.length, targets }
}

const NEXT_TRIGGER = /^\s*(?:\/costs(?:@\w+)?|что\s+дальше|себестоимость|tannarx)(?![\p{L}\p{N}])[\s,:.?!—-]*$/iu

/** The owner asked what to price next. Deliberately an exact phrase, not a guess at intent. */
export function asksWhatNext(text: string): boolean {
  return NEXT_TRIGGER.test(String(text ?? ''))
}
