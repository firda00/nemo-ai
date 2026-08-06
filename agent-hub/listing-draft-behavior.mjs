import assert from 'node:assert/strict'
import {
  COPY_SYSTEM_PROMPT,
  categoryCandidates,
  draftEconomics,
  extractNumbers,
  parseCopy,
} from '../supabase/functions/_shared/listingDraft.ts'

const uzs = (value) => value * 100

// --- Numbers come from the owner's words, by pattern, never from a model -------------------

const full = extractNumbers('Хиджаб шифоновый, упаковка 238x138x34 мм, вес 120 г, себестоимость 18000 сум')
assert.deepEqual(
  { ...full.dimension },
  { length: 238, width: 138, height: 34, weight: 120 },
  'millimetres and grams as stated',
)
assert.equal(full.unitCostTiyin, uzs(18_000), 'cost is stored in tiyin')
assert.ok(full.evidence.length >= 3, 'every number carries the text it came from')

// Centimetres are the other way sellers write it, and the tariff is in millimetres.
const cm = extractNumbers('коробка 23,8 х 13,8 х 3,4 см')
assert.deepEqual({ ...cm.dimension }, { length: 238, width: 138, height: 34, weight: null })

// Kilograms too.
assert.equal(extractNumbers('упаковка 10x10x10 мм, 1,2 кг').dimension.weight, 1200)

// A bare number is not a price. "46 размер" must never become a cost.
const sizes = extractNumbers('Хиджаб бордовый, 46 размер, 3 штуки')
assert.equal(sizes.unitCostTiyin, null, 'a number without a cost word is not a cost')
assert.equal(sizes.dimension, null, 'and nothing invents dimensions')
assert.deepEqual(sizes.evidence, [], 'no numbers taken means no evidence claimed')

// Uzbek phrasing for the same thing.
assert.equal(extractNumbers('tannarxi 25000 som').unitCostTiyin, uzs(25_000))

// A weight with no dimensions is not enough to charge a volume fee, so it is not kept alone.
assert.equal(extractNumbers('вес 300 г').dimension, null)

// --- The commission is read off categories the seller already sells in ---------------------

const CATEGORIES = [
  { category: 'Hijob va tyurbanlar', commission_percent: 30, returns_reserve_percent: 40.7, skus: 24 },
  { category: 'Sharflar', commission_percent: 30, returns_reserve_percent: 52.5, skus: 6 },
  { category: 'Ikki qismli choʻmilish kiyimlari', commission_percent: 25, returns_reserve_percent: 54, skus: 18 },
]

const matched = categoryCandidates('yangi hijob, shifon', CATEGORIES)
assert.equal(matched.confident, true, 'a shared word is a real match')
assert.equal(matched.options[0].category, 'Hijob va tyurbanlar')

// The owner writes Russian, Uzum names the category in Uzbek: no overlap, and that is normal.
// The honest answer is the whole list to pick from, not a confident guess.
const unmatched = categoryCandidates('новый купальник раздельный', CATEGORIES)
assert.equal(unmatched.confident, false, 'no shared word means no confident match')
assert.equal(unmatched.options.length, 3, 'the owner gets every category they actually sell in')
assert.equal(unmatched.options[0].skus, 24, 'ordered by how much of their catalogue sits there')

// A seller with no synced catalogue has no commission to borrow at all.
assert.deepEqual(categoryCandidates('что угодно', []), { confident: false, options: [] })

// --- Economics: facts, or a named gap ------------------------------------------------------

const complete = draftEconomics({
  dimension: { length: 238, width: 138, height: 34, weight: 120 },
  unitCostTiyin: uzs(18_000),
  category: CATEGORIES[0],
  minMarginPercent: 20,
})
assert.equal(complete.volume_litres, 2, '238x138x34 rounds up to 2 litres')
assert.equal(complete.fulfillment_tiyin, uzs(5_500), 'base 5 250 plus one extra litre')
assert.equal(complete.fulfillment_basis, 'dimensions')
assert.deepEqual(complete.missing, [], 'nothing missing when everything was stated')
assert.ok(complete.min_selling_price_tiyin > uzs(18_000), 'the floor clears cost, fee and commission')

// No dimensions is not a free product: Uzum charges the full "без ВГХ" rate, and so does the draft.
const noDimensions = draftEconomics({
  dimension: null,
  unitCostTiyin: uzs(18_000),
  category: CATEGORIES[0],
  minMarginPercent: 20,
})
assert.equal(noDimensions.fulfillment_tiyin, uzs(50_000), 'unmeasured products pay the maximum')
assert.equal(noDimensions.fulfillment_basis, 'no_dimensions')
assert.deepEqual(noDimensions.missing, ['dimensions'])
assert.ok(
  noDimensions.min_selling_price_tiyin > complete.min_selling_price_tiyin,
  'and that shows up as a higher floor price, which is the point',
)

// Without a category there is no commission anyone can defend, so there is no floor price either.
const noCategory = draftEconomics({
  dimension: { length: 238, width: 138, height: 34, weight: null },
  unitCostTiyin: uzs(18_000),
  category: null,
  minMarginPercent: 20,
})
assert.equal(noCategory.commission_percent, null)
assert.equal(noCategory.min_selling_price_tiyin, null, 'no invented commission, no invented floor')
assert.deepEqual(noCategory.missing, ['category'])

// Same for a product whose cost the owner has not named.
const noCost = draftEconomics({ dimension: null, unitCostTiyin: null, category: null, minMarginPercent: 20 })
assert.deepEqual(noCost.missing, ['dimensions', 'unit_cost', 'category'], 'every gap is named, in order')
assert.equal(noCost.min_selling_price_tiyin, null)
assert.equal(noCost.fulfillment_tiyin, uzs(50_000), 'the fee is still known even when nothing else is')

// --- The model writes prose, and only prose ------------------------------------------------

for (const rule of ['Never invent a material', 'Never write a price', 'unknown_attributes']) {
  assert.ok(COPY_SYSTEM_PROMPT.includes(rule), `the prompt must forbid: ${rule}`)
}

const copy = parseCopy({
  title_ru: '  Хиджаб   шифоновый  ',
  title_uz: 'Shifon hijob',
  description_ru: 'Лёгкий платок из шифона.',
  description_uz: 'Shifondan yengil roʻmol.',
  attributes: [
    { name: 'Материал', value: 'шифон' },
    { name: 'Цвет', value: '' },
    { name: '', value: 'мусор' },
  ],
  unknown_attributes: ['Размер', ''],
  price_uzs: 90000,
})
assert.equal(copy.title_ru, 'Хиджаб шифоновый', 'whitespace is normalised')
assert.deepEqual(copy.attributes, [{ name: 'Материал', value: 'шифон' }], 'half-filled attributes are dropped')
assert.deepEqual(copy.unknown_attributes, ['Размер'])
assert.equal('price_uzs' in copy, false, 'a price from the model is discarded, never stored')

// A model that answers with nothing usable must not produce a half-real listing.
const empty = parseCopy({ title_ru: '   ', attributes: 'not an array', unknown_attributes: null })
assert.equal(empty.title_ru, null)
assert.deepEqual(empty.attributes, [])
assert.deepEqual(empty.unknown_attributes, [])
assert.equal(parseCopy(null), null)
assert.equal(parseCopy('{"title_ru":"x"}'), null, 'a string is not a parsed object')

console.log('[OK] Listing draft behaviour: 34 assertions')
