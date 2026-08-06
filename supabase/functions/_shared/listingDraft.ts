// Listing Agent: turns what the owner says about a product into a draft that already knows its
// own economics.
//
// NEMO NEVER PUBLISHES. The Uzum integration is read-only, so a draft is something the owner
// copies into their cabinet themselves. There is deliberately no 'published' status anywhere in
// this feature — a status Nemo cannot honestly set is a status that would eventually lie.
//
// The division of labour is the same one that holds everywhere else in Commerce: the model writes
// PROSE, and arithmetic touches money. A title can be rewritten if it reads badly. A cost that a
// model rounded silently poisons every margin downstream, so every number here is extracted by
// pattern from the owner's own words, and anything not stated stays missing and is named.

import { fulfillmentTiyin, volumeLitres, type SkuDimension } from './uzumLogistics.ts'
import { minSellingPriceTiyin, type Fees } from './unitEconomics.ts'
// llm.ts is imported lazily inside generateCopy, NOT here. It reads Deno.env at module load, and
// the arithmetic in this file is behaviour-tested under Node — a top-level import would make the
// whole module unloadable outside Deno and quietly cost it its tests.

/** Anything the owner did not say. Named, never filled in. */
export type MissingField =
  | 'dimensions'
  | 'unit_cost'
  | 'category'

export interface ExtractedNumbers {
  dimension: SkuDimension | null
  unitCostTiyin: number | null
  /** The exact substrings the numbers came from, so the owner can check them. */
  evidence: string[]
}

const DECIMAL = String.raw`\d{1,6}(?:[.,]\d{1,2})?`
const num = (raw: string) => Number(String(raw).replace(/[\s\u00a0]/g, '').replace(',', '.'))

// "238x138x34", "238 х 138 х 34 мм", "23,8 * 13,8 * 3,4 см". Both the Latin x and the Cyrillic х
// appear in practice, often in the same catalogue, and the multiplication sign shows up when the
// text was pasted from a spec sheet.
// `\b` is useless here: it is defined on [A-Za-z0-9_], so in "120 г," the boundary after a
// Cyrillic г never matches and the weight is silently dropped. A lookahead for "not a letter" is
// what was meant, and it works in both alphabets.
const END = String.raw`(?![\p{L}])`
const DIMENSION = new RegExp(
  String.raw`(${DECIMAL})\s*[xх×*]\s*(${DECIMAL})\s*[xх×*]\s*(${DECIMAL})\s*(мм|mm|см|sm|cm|м|m)?${END}`,
  'iu',
)
const WEIGHT = new RegExp(String.raw`(${DECIMAL})\s*(кг|kg|gramm|гр|gr|г|g)${END}`, 'iu')
// A cost needs a word that means cost. A bare number in "хиджаб 46 размер" is not a price, and
// reading it as one would be worse than asking.
const COST = new RegExp(
  String.raw`(?:себестоимост\w*|закуп\w*|tannarx\w*|zakup\w*|cost)\D{0,20}(\d[\d\s\u00a0]{2,12})`,
  'i',
)

/** Millimetres, whatever unit the owner used. Uzum states dimensions in mm and so does the tariff. */
function toMillimetres(value: number, unit: string | undefined): number {
  const suffix = (unit ?? 'мм').toLowerCase()
  if (suffix.startsWith('см') || suffix.startsWith('sm') || suffix.startsWith('cm')) return Math.round(value * 10)
  if (suffix === 'м' || suffix === 'm') return Math.round(value * 1000)
  return Math.round(value)
}

function toGrams(value: number, unit: string): number {
  return /^(кг|kg)$/i.test(unit) ? Math.round(value * 1000) : Math.round(value)
}

export function extractNumbers(sourceText: string): ExtractedNumbers {
  const text = String(sourceText ?? '').replace(/\u00a0/g, ' ')
  const evidence: string[] = []

  let dimension: SkuDimension | null = null
  const dimensionHit = text.match(DIMENSION)
  if (dimensionHit) {
    const [length, width, height] = [dimensionHit[1], dimensionHit[2], dimensionHit[3]].map(num)
    if ([length, width, height].every((v) => Number.isFinite(v) && v > 0)) {
      dimension = {
        length: toMillimetres(length, dimensionHit[4]),
        width: toMillimetres(width, dimensionHit[4]),
        height: toMillimetres(height, dimensionHit[4]),
        weight: null,
      }
      evidence.push(dimensionHit[0].trim())
    }
  }

  const weightHit = text.match(WEIGHT)
  if (weightHit && dimension) {
    const grams = toGrams(num(weightHit[1]), weightHit[2])
    if (Number.isFinite(grams) && grams > 0) {
      dimension.weight = grams
      evidence.push(weightHit[0].trim())
    }
  }

  let unitCostTiyin: number | null = null
  const costHit = text.match(COST)
  if (costHit) {
    const uzs = num(costHit[1])
    if (Number.isFinite(uzs) && uzs > 0) {
      unitCostTiyin = Math.round(uzs * 100)
      evidence.push(costHit[0].trim())
    }
  }

  return { dimension, unitCostTiyin, evidence }
}

export interface CategoryOption {
  category: string
  commission_percent: number
  returns_reserve_percent: number | null
  /** How many of the seller's own SKUs sit in it. This is why the commission is a fact. */
  skus: number
}

const STOP = new Set(['для', 'и', 'с', 'на', 'в', 'the', 'and', 'va', 'uchun', 'сум', 'so', 'мм', 'см'])
const tokens = (value: string) =>
  String(value ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2 && !STOP.has(word))

/** One of the seller's existing products: how they name it, and where Uzum filed it. */
export interface SkuExemplar {
  text: string
  category: string
}

/**
 * Candidate categories, best first.
 *
 * The commission is never guessed: it is read off categories the seller ALREADY sells in, where
 * Uzum has stated it. A new product in a category they have never touched has no commission Nemo
 * can honestly claim, and the draft says so rather than borrowing a number from a neighbour.
 *
 * Two signals, both facts about this seller:
 *
 *   1. Words shared with the category NAME. Specific when it hits, and it usually does not — the
 *      owner writes Russian and Uzum names the category in Uzbek, so "хиджаб" and "Hijob va
 *      tyurbanlar" share nothing. One matched word is enough here, because category names have
 *      no filler.
 *   2. Words shared with their OWN PRODUCT NAMES. This is the signal that works: they already
 *      sell "Женский бони Белый", Uzum already filed it under Hijob va tyurbanlar, and a new
 *      "Женский хиджаб-бони из шифона" is plainly the same shelf. Two matched words minimum,
 *      because a single "женский" is true of half the catalogue and would decide nothing.
 *
 * A tie decides nothing either: two categories with equal evidence means the owner picks. And
 * with no match at all the full list comes back to pick from, which is one tap and always right.
 */
export function categoryCandidates(
  sourceText: string,
  options: CategoryOption[],
  exemplars: SkuExemplar[] = [],
): { confident: boolean; options: CategoryOption[] } {
  const words = new Set(tokens(sourceText))
  const shared = (value: string) => tokens(value).filter((word) => words.has(word)).length

  // Best exemplar evidence per category. Kept separate from the name score so the two signals
  // keep their own thresholds instead of being averaged into something meaningless.
  const byExemplar = new Map<string, number>()
  for (const exemplar of exemplars) {
    const score = shared(exemplar.text)
    if (score >= 2 && score > (byExemplar.get(exemplar.category) ?? 0)) byExemplar.set(exemplar.category, score)
  }

  const scored = options
    .map((option) => ({ option, score: Math.max(shared(option.category), byExemplar.get(option.category) ?? 0) }))
    .sort((a, b) => b.score - a.score || b.option.skus - a.option.skus)

  const best = scored[0]
  const runnerUp = scored[1]
  const decisive = Boolean(best) && best.score > 0 && (!runnerUp || runnerUp.score < best.score)
  if (decisive) return { confident: true, options: scored.filter((row) => row.score > 0).map((row) => row.option) }
  return { confident: false, options: scored.map((row) => row.option) }
}

export interface DraftEconomics {
  fulfillment_tiyin: number
  /** Which branch of the tariff produced the fee, so the number can be argued with. */
  fulfillment_basis: 'dimensions' | 'no_dimensions'
  volume_litres: number | null
  commission_percent: number | null
  returns_reserve_percent: number | null
  unit_cost_tiyin: number | null
  min_margin_percent: number
  min_selling_price_tiyin: number | null
  missing: MissingField[]
}

/**
 * What the listing costs to sell, before it exists.
 *
 * Every input is either a fact or absent. A missing dimension does NOT mean a missing fee: Uzum
 * charges the full "без ВГХ" rate for a product it cannot measure, so that is what the draft
 * shows — the expensive truth, which is also the cheapest way to make someone go and measure.
 */
export function draftEconomics(input: {
  dimension: SkuDimension | null
  unitCostTiyin: number | null
  category: CategoryOption | null
  minMarginPercent: number
}): DraftEconomics {
  const missing: MissingField[] = []
  if (!input.dimension) missing.push('dimensions')
  if (input.unitCostTiyin == null) missing.push('unit_cost')
  if (!input.category) missing.push('category')

  const fulfillment = fulfillmentTiyin(input.dimension)
  const commission = input.category?.commission_percent ?? null
  const returns = input.category?.returns_reserve_percent ?? null

  // The floor price needs the commission and the cost. Without either there is no honest number,
  // and a floor computed from a guessed commission is exactly the kind of confident wrong answer
  // this feature exists to avoid.
  const fees: Fees | null = commission == null ? null : {
    commission_percent: commission,
    returns_reserve_percent: returns ?? 0,
    fulfillment_tiyin: fulfillment,
  }
  const floor = fees && input.unitCostTiyin != null
    ? minSellingPriceTiyin(input.unitCostTiyin, input.minMarginPercent, fees)
    : null

  return {
    fulfillment_tiyin: fulfillment,
    fulfillment_basis: input.dimension ? 'dimensions' : 'no_dimensions',
    volume_litres: volumeLitres(input.dimension),
    commission_percent: commission,
    returns_reserve_percent: returns,
    unit_cost_tiyin: input.unitCostTiyin,
    min_margin_percent: input.minMarginPercent,
    min_selling_price_tiyin: floor,
    missing,
  }
}

export interface ListingCopy {
  title_ru: string | null
  title_uz: string | null
  description_ru: string | null
  description_uz: string | null
  attributes: Array<{ name: string; value: string }>
  unknown_attributes: string[]
}

export const COPY_SCHEMA =
  '{"title_ru":"string, up to 100 chars, Russian","title_uz":"string, up to 100 chars, Uzbek latin",'
  + '"description_ru":"string, 1-3 sentences, Russian","description_uz":"string, 1-3 sentences, Uzbek latin",'
  + '"attributes":[{"name":"string, characteristic name","value":"string, its value EXACTLY as the owner stated it"}],'
  + '"unknown_attributes":["string, names of characteristics a buyer would expect but the owner did not state"]}'

/**
 * The only place a model is allowed to speak. It writes the listing text and nothing else: no
 * price, no fee, no dimension, no invented characteristic. `unknown_attributes` is the useful
 * half of its answer — it turns "the model does not know" into a checklist for the owner.
 */
export const COPY_SYSTEM_PROMPT = [
  'You write marketplace listing copy for an Uzbek seller on Uzum Market.',
  'Reply with JSON only, matching this schema exactly:',
  COPY_SCHEMA,
  'Rules you must not break:',
  '1. Use ONLY facts stated in the owner text. Never invent a material, size, colour, brand, certification, country of origin or compatibility.',
  '2. Put a characteristic in "attributes" only if its value appears in the owner text. Otherwise put its NAME in "unknown_attributes" and leave it out.',
  '3. Never write a price, a discount, a delivery time or a warranty. Those are set elsewhere and would be wrong here.',
  '4. No superlatives that cannot be checked: no "best", "premium", "highest quality", "eng yaxshi".',
  '5. Russian in the _ru fields, Uzbek latin script in the _uz fields. The Uzbek is a translation of the same claims, not a different product.',
  '6. If the owner text is too vague to name the product at all, return nulls and list what you would need in "unknown_attributes".',
].join('\n')

/**
 * Writes the listing text. Returns null when the model fails or answers with nothing usable —
 * the caller stores the draft anyway, because the ECONOMICS are the part that does not depend on
 * a model being available, and a draft with real numbers and no copy is still worth having.
 */
export async function generateCopy(apiKey: string, model: string, sourceText: string): Promise<ListingCopy | null> {
  const { callOpenRouter, stripJsonFence } = await import('./llm.ts')
  const raw = await callOpenRouter({
    apiKey,
    model,
    temperature: 0.2,
    maxTokens: 700,
    responseFormat: { type: 'json_object' },
    messages: [
      { role: 'system', content: COPY_SYSTEM_PROMPT },
      { role: 'user', content: String(sourceText ?? '').slice(0, 2000) },
    ],
  })
    .then((res) => JSON.parse(stripJsonFence(res.content)) as unknown)
    .catch(() => null)
  return parseCopy(raw)
}

/** Rejects anything the model added beyond the schema, and anything it made up in the wrong shape. */
export function parseCopy(raw: unknown): ListingCopy | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const text = (value: unknown, limit: number): string | null => {
    const cleaned = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
    return cleaned ? cleaned.slice(0, limit) : null
  }
  const attributes = Array.isArray(row.attributes)
    ? row.attributes
      .map((entry) => ({ name: text((entry as Record<string, unknown>)?.name, 60), value: text((entry as Record<string, unknown>)?.value, 200) }))
      .filter((entry): entry is { name: string; value: string } => Boolean(entry.name && entry.value))
      .slice(0, 30)
    : []
  const unknown = Array.isArray(row.unknown_attributes)
    ? row.unknown_attributes.map((entry) => text(entry, 60)).filter((entry): entry is string => Boolean(entry)).slice(0, 20)
    : []
  return {
    title_ru: text(row.title_ru, 100),
    title_uz: text(row.title_uz, 100),
    description_ru: text(row.description_ru, 800),
    description_uz: text(row.description_uz, 800),
    attributes,
    unknown_attributes: unknown,
  }
}
