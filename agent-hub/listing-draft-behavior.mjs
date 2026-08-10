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
// With nothing else to go on the honest answer is the whole list to pick from.
const unmatched = categoryCandidates('новый купальник раздельный', CATEGORIES)
assert.equal(unmatched.confident, false, 'no shared word means no confident match')
assert.equal(unmatched.options.length, 3, 'the owner gets every category they actually sell in')
assert.equal(unmatched.options[0].skus, 24, 'ordered by how much of their catalogue sits there')

// ...but their own product names DO overlap, and Uzum already filed those. This is the signal
// that makes the feature usable for a Russian-writing seller instead of asking every single time.
const EXEMPLARS = [
  { text: 'Женский бони Белый AYOL88-BONI-БЕЛЫЙ', category: 'Hijob va tyurbanlar' },
  { text: 'Женский бони Бордовый AYOL88-BONI-БОРДОВ', category: 'Hijob va tyurbanlar' },
  { text: 'Женский купальник раздельный алый AYOL88-KUPALNIK1', category: 'Ikki qismli choʻmilish kiyimlari' },
  { text: 'Волнистый шарф молочный AYOL88-SHARF', category: 'Sharflar' },
]

const viaExemplar = categoryCandidates('Женский хиджаб-бони из шифона, цвет молочный', CATEGORIES, EXEMPLARS)
assert.equal(viaExemplar.confident, true, 'their own product names bridge the language gap')
assert.equal(viaExemplar.options[0].category, 'Hijob va tyurbanlar')

const swimwear = categoryCandidates('Новый женский купальник раздельный, размеры 42-48', CATEGORIES, EXEMPLARS)
assert.equal(swimwear.confident, true)
assert.equal(swimwear.options[0].category, 'Ikki qismli choʻmilish kiyimlari', 'and it picks the right shelf, not the biggest one')

// One shared word decides nothing: half the catalogue is "женский".
const tooWeak = categoryCandidates('женский товар', CATEGORIES, EXEMPLARS)
assert.equal(tooWeak.confident, false, 'a single common word must not choose a commission')

// Equal evidence on two shelves is also a question for the owner, not a coin flip.
const tie = categoryCandidates('женский бони купальник', CATEGORIES, [
  { text: 'Женский бони Белый', category: 'Hijob va tyurbanlar' },
  { text: 'Женский купальник алый', category: 'Ikki qismli choʻmilish kiyimlari' },
])
assert.equal(tie.confident, false, 'a tie is not a decision')

// A seller with no synced catalogue has no commission to borrow at all.
assert.deepEqual(categoryCandidates('что угодно', []), { confident: false, options: [] })

// The shelf carries its own shop with it. This seller has four catalogues discovered in the same
// second, and the first version picked one of them by an ordering tie — a hijab was priced against
// a catalogue of three washing bags at 20% while 110 hijab SKUs sat in a catalogue never opened.
const MULTI_SHOP = [
  { category: 'Kiyim va poyabzallarni yuvish uchun sumkalar, qoplar', commission_percent: 20, returns_reserve_percent: 22, skus: 3, catalog_id: 'everly-home', min_margin_percent: 15 },
  { category: 'Hijob va tyurbanlar', commission_percent: 30, returns_reserve_percent: 43, skus: 24, catalog_id: 'ayollar-olami', min_margin_percent: 20 },
]
const across = categoryCandidates('женский хиджаб-бони из шифона, молочный', MULTI_SHOP, [
  { text: 'Женский бони Молочный AYOL88-BONI-МОЛОЧ', category: 'Hijob va tyurbanlar' },
  { text: 'Мешок для стирки UY01-MESHOK', category: 'Kiyim va poyabzallarni yuvish uchun sumkalar, qoplar' },
])
assert.equal(across.confident, true, 'the hijab must reach the hijab shelf across catalogues')
assert.equal(across.options[0].catalog_id, 'ayollar-olami', 'and bring its own catalogue with it')

const priced = draftEconomics({
  dimension: { length: 238, width: 138, height: 34, weight: 120 },
  unitCostTiyin: uzs(18_000),
  category: across.options[0],
  minMarginPercent: across.options[0].min_margin_percent,
})
assert.equal(priced.commission_percent, 30, 'the commission is the hijab one, not the washing-bag one')
assert.equal(priced.min_selling_price_tiyin, uzs(47_000), '(18000 + 5500) / (1 - 0.30 - 0.20) = 47 000')

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

// --- The description keeps its blocks -------------------------------------------------------
// Схлопывание пробелов уничтожало структуру раньше, чем она доезжала до базы, — и промпт со
// всеми правилами о буллетах не менял ничего. Здесь проверяется именно граница парсера.

for (const rule of ['Основные преимущества:', 'Характеристики:', 'Asosiy afzalliklari:', 'Xususiyatlari:']) {
  assert.ok(COPY_SYSTEM_PROMPT.includes(rule), `the prompt must ask for the block header: ${rule}`)
}
assert.ok(COPY_SYSTEM_PROMPT.includes('PLAIN TEXT ONLY'), 'markup would arrive in the Uzum form as literal characters')

const structured = parseCopy({
  title_ru: 'Хиджаб шифоновый',
  description_ru: 'Крючок  в   одну строку.\r\n\n\n\nВведение.\n\nОсновные преимущества:\n•  Шифон —  дышит.\n• Лёгкий — не давит.',
  description_uz: 'Ilgak.\n\nAsosiy afzalliklari:\n• Shifon — nafas oladi.',
})
assert.ok(structured.description_ru.includes('\n'), 'the description keeps its line breaks')
assert.equal(
  structured.description_ru,
  'Крючок в одну строку.\n\nВведение.\n\nОсновные преимущества:\n• Шифон — дышит.\n• Лёгкий — не давит.',
  'spaces collapse inside a line, breaks survive, and a run of blank lines becomes one',
)
assert.ok(structured.description_uz.includes('Asosiy afzalliklari:'), 'the uzbek block header survives too')
// Заголовок остаётся однострочным: перенос в поле названия на Uzum — не структура, а мусор.
assert.equal(parseCopy({ title_ru: 'Хиджаб\nшифоновый' }).title_ru, 'Хиджаб шифоновый')

// Воздух между блоками ставит парсер, а не уговоры. Модель выполняет требование о структуре и
// теряет требование о пустой строке — на телефоне это снова стена текста.
const glued = parseCopy({
  description_ru: 'Хук про шифон.\nВведение в две строки.\nОсновные преимущества:\n• Один — да.\nХарактеристики:\n• Цвет: пудровый',
})
assert.equal(
  glued.description_ru,
  'Хук про шифон.\n\nВведение в две строки.\n\nОсновные преимущества:\n• Один — да.\n\nХарактеристики:\n• Цвет: пудровый',
  'a header gets a blank line before it, a bullet does not',
)
// Хук отделяется и когда модель склеила его с введением в один абзац.
assert.ok(
  parseCopy({ description_ru: 'Хук про шифон. Введение, которое приклеили к хуку.' }).description_ru
    .startsWith('Хук про шифон.\n\n'),
  'the first sentence stands on its own',
)
// Граница предложения требует пробела после точки — иначе резались бы числа.
assert.equal(
  parseCopy({ description_ru: 'Плотность 190 г/м2.' }).description_ru,
  'Плотность 190 г/м2.',
  'a single sentence is left alone',
)
assert.equal(
  parseCopy({ description_ru: 'Хлопок 1.5 мм плотный и мягкий.' }).description_ru,
  'Хлопок 1.5 мм плотный и мягкий.',
  'a decimal point is not a sentence boundary',
)

// Обрез длинного описания идёт по границе строки: половина буллета читается как поломка вёрстки.
const long = parseCopy({ description_ru: `Крючок.\n\n${'• Очень длинный пункт про шифон.\n'.repeat(200)}` })
assert.ok(long.description_ru.length <= 2200, 'the stored description stays inside the column check')
assert.ok(!long.description_ru.endsWith('шиф'), 'the cut lands on a line boundary, not mid-word')

console.log('[OK] Listing draft behaviour: 58 assertions')
