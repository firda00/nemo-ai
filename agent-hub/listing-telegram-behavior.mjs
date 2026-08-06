import assert from 'node:assert/strict'
import {
  CB_LISTING,
  CB_LISTING_CATEGORY,
  categoryToken,
  draftCard,
  draftKeyboard,
  newListingText,
} from '../supabase/functions/_shared/commerceListingChat.ts'

const uzs = (value) => value * 100

// --- The trigger is explicit, because guessing costs the owner either way -------------------

assert.equal(newListingText('/new хиджаб шифоновый молочный'), 'хиджаб шифоновый молочный')
assert.equal(newListingText('новый товар: хиджаб шифоновый'), 'хиджаб шифоновый')
assert.equal(newListingText('Новая позиция — купальник раздельный'), 'купальник раздельный')
assert.equal(newListingText('yangi mahsulot: shifon hijob boni'), 'shifon hijob boni')
// A transcribed voice note has no slash, which is exactly why the spoken forms are accepted.
assert.equal(newListingText('новый товар женский хиджаб бони из шифона'), 'женский хиджаб бони из шифона')

// The economics path must keep every message that is about an EXISTING product.
assert.equal(newListingText('XALTA 50*60 себестоимость 20000'), null, 'plain economics is not a new listing')
assert.equal(newListingText('сколько осталось хиджабов?'), null)
assert.equal(newListingText('/start'), null)

// Trigger with nothing after it asks for a description rather than drafting an empty product.
assert.equal(newListingText('/new'), '', 'a bare trigger returns the empty string, not null')
assert.equal(newListingText('новый товар'), '')

// --- Callback data must fit Telegram's 64-byte cap -----------------------------------------

const DRAFT_ID = '11111111-2222-4333-8444-555555555555'
const LONGEST_REAL_CATEGORY = 'Kiyim va poyabzallarni yuvish uchun sumkalar, qoplar'
const categories = [
  { category: LONGEST_REAL_CATEGORY, commission_percent: 20, returns_reserve_percent: 22, skus: 3 },
  { category: 'Hijob va tyurbanlar', commission_percent: 30, returns_reserve_percent: 43, skus: 24 },
]

const needsCategory = {
  id: DRAFT_ID,
  title_ru: 'Хиджаб шифоновый',
  title_uz: 'Shifon hijob',
  description_ru: null,
  uzum_category: null,
  commission_percent: null,
  length_mm: 238, width_mm: 138, height_mm: 34, weight_g: 120,
  fulfillment_tiyin: uzs(5_500),
  unit_cost_tiyin: uzs(18_000),
  min_margin_percent: 20,
  min_selling_price_tiyin: null,
  missing: ['category'],
  unknown_attributes: [],
  evidence: ['238x138x34 мм'],
}

const keyboard = draftKeyboard(needsCategory, categories)
const buttons = keyboard.inline_keyboard.flat()
for (const button of buttons) {
  const bytes = new TextEncoder().encode(button.callback_data).length
  assert.ok(bytes <= 64, `callback_data must fit Telegram's cap, "${button.callback_data}" is ${bytes} bytes`)
}
// Naming the category outright would have blown the cap: this is the case that forced the token.
assert.ok(
  new TextEncoder().encode(`${CB_LISTING_CATEGORY}:${DRAFT_ID}:${LONGEST_REAL_CATEGORY}`).length > 64,
  'the naive encoding really is too long — otherwise this guard is theatre',
)

// The token is stable across calls and distinct per category, which is what makes it resolvable.
assert.equal(categoryToken(LONGEST_REAL_CATEGORY), categoryToken(LONGEST_REAL_CATEGORY))
assert.notEqual(categoryToken('Hijob va tyurbanlar'), categoryToken('Sharflar'))
assert.match(categoryToken('Sharflar'), /^[0-9a-f]{8}$/)

// --- Buttons offer only what a button can honestly do ---------------------------------------

const categoryButtons = buttons.filter((button) => button.callback_data.startsWith(`${CB_LISTING_CATEGORY}:`))
assert.equal(categoryButtons.length, 2, 'a missing category is one tap, so the shelves are offered')
assert.equal(
  buttons.some((button) => button.callback_data.endsWith(':y')),
  false,
  'approval must not be offered while anything is missing',
)

// Dimensions and cost cannot come from a button, so none pretends otherwise.
const needsNumbers = { ...needsCategory, missing: ['dimensions', 'unit_cost', 'category'], length_mm: null, width_mm: null, height_mm: null, unit_cost_tiyin: null, fulfillment_tiyin: uzs(50_000) }
const numbersKeyboard = draftKeyboard(needsNumbers, categories).inline_keyboard.flat()
assert.equal(numbersKeyboard.some((button) => button.callback_data.endsWith(':y')), false)

const complete = { ...needsCategory, missing: [], uzum_category: 'Hijob va tyurbanlar', commission_percent: 30, min_selling_price_tiyin: uzs(47_000) }
const completeKeyboard = draftKeyboard(complete, categories).inline_keyboard.flat()
assert.equal(completeKeyboard.length, 2, 'a complete draft offers approve and discard, nothing else')
assert.equal(completeKeyboard[0].callback_data, `${CB_LISTING}:${DRAFT_ID}:y`)

// --- The card states facts and gaps, never a filled-in guess ---------------------------------

const cardComplete = draftCard(complete)
// toLocaleString('ru-RU') groups thousands with a non-breaking space, which \s matches and a
// literal space in this pattern would not.
assert.match(cardComplete, /Минимальная цена: 47\s000\s?сум/, 'the floor price is the point of the card')
assert.match(cardComplete, /Комиссия Uzum: 30%/)
assert.match(cardComplete, /238×138×34 мм/)
assert.match(cardComplete, /ничего не публикует на Uzum/, 'the read-only promise is on the card the owner approves')
assert.doesNotMatch(cardComplete, /Не хватает/)

const cardMissing = draftCard(needsNumbers)
assert.match(cardMissing, /Не хватает/)
assert.match(cardMissing, /габариты/)
assert.match(cardMissing, /себестоимость/)
assert.match(cardMissing, /Минимальная цена: нечем считать/, 'no commission and no cost means no floor, stated plainly')
assert.match(cardMissing, /50\s000\s?сум — тариф «без ВГХ»/, 'the penalty fee is shown with its reason')
assert.doesNotMatch(cardMissing, /ничего не публикует/, 'the approval promise belongs only on an approvable draft')

// A title from a model is escaped like any other untrusted text.
const injected = draftCard({ ...complete, title_ru: '<b>Хиджаб</b> & <script>' })
assert.match(injected, /&lt;b&gt;Хиджаб&lt;\/b&gt; &amp; &lt;script&gt;/, 'model output is escaped, not rendered')

console.log('[OK] Listing Telegram behaviour: 30 assertions')
