import assert from 'node:assert/strict'
import {
  CB_COST_BATCH,
  asksWhatNext,
  batchCard,
  batchKeyboard,
  looksLikeCostBatch,
  matchBatch,
  nextCard,
  parseCostBatch,
} from '../supabase/functions/_shared/commerceCostCampaign.ts'

// --- The batch is parsed by pattern, because a cost poisons everything downstream -----------

const three = parseCostBatch('бони 18000, шарф 22000, заколки 9000')
assert.deepEqual(three.items, [
  { query: 'бони', costUzs: 18000 },
  { query: 'шарф', costUzs: 22000 },
  { query: 'заколки', costUzs: 9000 },
])
assert.deepEqual(three.unparsed, [])

// Dictated across lines, with the currency spoken out loud.
const lines = parseCostBatch('Женский бони Белый 18000 сум\nВолнистый шарф 22 000 som')
assert.deepEqual(lines.items, [
  { query: 'Женский бони Белый', costUzs: 18000 },
  { query: 'Волнистый шарф', costUzs: 22000 },
])

// The name carries digits of its own. The price is the number said LAST, every time.
assert.deepEqual(
  parseCostBatch('заколки 6шт 9000; бони 46 размер 18000').items,
  [{ query: 'заколки 6шт', costUzs: 9000 }, { query: 'бони 46 размер', costUzs: 18000 }],
)

// A comma inside a number is not a separator.
assert.equal(parseCostBatch('шарф 22,5').items.length, 0, 'a decimal alone is below the floor, not two items')

// Numbers too small to be a price are a quantity that wandered in. Reported, never stored: reading
// "6" from "заколки 6шт" as a cost would put a 99% margin on the table and leave it there.
const junk = parseCostBatch('заколки 6шт, бони 18000')
assert.deepEqual(junk.items, [{ query: 'бони', costUzs: 18000 }])
assert.deepEqual(junk.unparsed, ['заколки 6шт'])

// A number with no name has nothing to attach to.
assert.deepEqual(parseCostBatch('18000').unparsed, ['18000'])

// THE LINE THAT GOT THROUGH. The owner pasted a report back into the chat and "last number wins"
// read the shelf value as a purchase cost — 931 200 against a retail price of 116 400. Four SKUs
// took it, and a confirmed cost stops being an estimate, so they were one sync from raising
// critical alerts about a loss that never existed.
const pasted = parseCostBatch([
  '• AYOL88-CHECHENKA-ЧЕРН      116 400 × 8  →  931 200 сум на полке',
  '• AYOL88-CHECHENKA-СЕРЫЙ     116 400 × 8  →  931 200',
  '• AYOL88-КУПАЛЬНИК1-ЛАЙМ-50  339 500 × 2  →  679 000',
].join('\n'))
assert.deepEqual(pasted.items, [], 'a computed line is never a dictated cost')
assert.equal(pasted.unparsed.length, 3, 'and all three are reported back')
// The same arithmetic in the other notations people paste.
assert.deepEqual(parseCostBatch('бони 116400 x 8 = 931200').items, [])
assert.deepEqual(parseCostBatch('шарф 22000 → 44000').items, [])

// One cost is the existing single-item flow, which also understands lead times and margins.
assert.equal(looksLikeCostBatch('бони 18000'), false, 'one item is not a batch')
assert.equal(looksLikeCostBatch('бони 18000, шарф 22000'), true)
assert.equal(looksLikeCostBatch('сколько осталось хиджабов?'), false)

// --- Matching: exact or asked, never the first plausible row -------------------------------

const SKUS = [
  { id: 'a', external_sku: 'Женский бони Белый', title: 'AYOL88-BONI-БЕЛЫЙ' },
  { id: 'b', external_sku: 'Женский бони Чёрный', title: 'AYOL88-BONI-ЧЕРН' },
  { id: 'c', external_sku: 'Волнистый шарф молочный', title: 'AYOL88-SHARF-МОЛОЧ' },
]
const fakeMatch = (query, skus) => skus.filter((sku) => `${sku.external_sku} ${sku.title}`.toLowerCase().includes(query.toLowerCase()))

const matched = matchBatch(
  [{ query: 'Волнистый шарф', costUzs: 22000 }, { query: 'бони', costUzs: 18000 }, { query: 'носки', costUzs: 5000 }],
  SKUS,
  fakeMatch,
)
assert.equal(matched[0].kind, 'matched')
assert.equal(matched[0].sku.id, 'c')
assert.equal(matched[1].kind, 'ambiguous', 'two colours match "бони", so the owner decides')
assert.equal(matched[1].candidates.length, 2)
assert.equal(matched[2].kind, 'unknown', 'nothing in the catalogue is a sock')

// The second defence, and the one that does not depend on how the number was read: nobody buys
// for what they sell for, so a cost at or above the retail price is never a purchase price.
const prices = { a: 35000, b: 35000, c: 116400 }
const implausible = matchBatch([{ query: 'Волнистый шарф', costUzs: 931200 }], SKUS, fakeMatch, prices)
assert.equal(implausible[0].kind, 'implausible')
assert.equal(implausible[0].priceUzs, 116400)
// Equal is refused too: a purchase price identical to the selling price is not one either.
assert.equal(matchBatch([{ query: 'Волнистый шарф', costUzs: 116400 }], SKUS, fakeMatch, prices)[0].kind, 'implausible')
assert.equal(matchBatch([{ query: 'Волнистый шарф', costUzs: 40000 }], SKUS, fakeMatch, prices)[0].kind, 'matched')
// A SKU never observed has no price to compare against, so the check stands aside rather than
// blocking a cost the owner is entitled to give.
assert.equal(matchBatch([{ query: 'Волнистый шарф', costUzs: 931200 }], SKUS, fakeMatch, { c: null })[0].kind, 'matched')

const refusedCard = batchCard(implausible, [], 10)
assert.match(refusedCard, /не ниже цены продажи/)
assert.match(refusedCard, /Это не закупка/)
assert.equal(batchKeyboard('k', implausible.filter((row) => row.kind === 'matched').length), undefined)

// --- The card states what will be written, and what will not -------------------------------

const card = batchCard(matched, ['заколки 6шт'], 135)
assert.match(card, /Себестоимость — 1 из 3/)
assert.match(card, /AYOL88-SHARF-МОЛОЧ/)
assert.match(card, /22\s000\s?сум/)
assert.match(card, /подходит 2/, 'ambiguity is named, not resolved')
assert.match(card, /в каталоге не нашёл/)
assert.match(card, /не понял цену/)
assert.match(card, /Непонятые строки не сохраняются/)
assert.match(card, /останется без себестоимости: <b>134<\/b>/, 'progress counts only what will actually be saved')

// Nothing savable means no save button — a button that writes nothing is a lie about what happened.
assert.equal(batchKeyboard('k', 0), undefined)
const keyboard = batchKeyboard('11111111-2222-4333-8444-555555555555', 3)
assert.equal(keyboard.inline_keyboard[0][0].callback_data, `${CB_COST_BATCH}:11111111-2222-4333-8444-555555555555:y`)
for (const button of keyboard.inline_keyboard.flat()) {
  assert.ok(new TextEncoder().encode(button.callback_data).length <= 64, 'Telegram caps callback_data at 64 bytes')
}
assert.match(keyboard.inline_keyboard[0][0].text, /Сохранить 3/)

// --- "What next" names the SKUs carrying the most money ------------------------------------

const targets = [
  { title: 'AYOL88-KUPALNIK-АЛЫЙ', external_sku: 'Купальник алый', price_uzs: 350000, stock: 12 },
  { title: 'AYOL88-BONI-БЕЛЫЙ', external_sku: 'Женский бони Белый', price_uzs: 35000, stock: 8 },
]
const next = nextCard(targets, 135)
assert.match(next, /Осталось без себестоимости: 135/)
assert.match(next, /AYOL88-KUPALNIK-АЛЫЙ/)
assert.match(next, /350\s000\s?сум/)
assert.match(next, /остаток 12/)
assert.match(next, /AYOL88-KUPALNIK-АЛЫЙ 18000, AYOL88-BONI-БЕЛЫЙ 22000/, 'the example uses their own product names')

// Finished is a different message, not a list of zero things to do.
const done = nextCard([], 0)
assert.match(done, /заполнена везде/)
assert.doesNotMatch(done, /Осталось/)

// The trigger is an exact phrase. "Что дальше по хиджабам?" is a question for the agent, not a
// request for the campaign queue.
assert.equal(asksWhatNext('/costs'), true)
assert.equal(asksWhatNext('что дальше'), true)
assert.equal(asksWhatNext('Что дальше?'), true)
assert.equal(asksWhatNext('себестоимость'), true)
assert.equal(asksWhatNext('что дальше по хиджабам'), false)
assert.equal(asksWhatNext('бони 18000, шарф 22000'), false)

// Model output and product names reach Telegram escaped.
assert.match(
  batchCard([{ kind: 'unknown', item: { query: '<b>x</b>', costUzs: 9000 } }], [], 5),
  /&lt;b&gt;x&lt;\/b&gt;/,
)

console.log('[OK] Cost campaign behaviour: 52 assertions')
