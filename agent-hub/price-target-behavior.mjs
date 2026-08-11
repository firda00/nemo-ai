import assert from 'node:assert/strict'
import {
  adviceForDeadstock,
  adviceForMargin,
  adviceMessage,
  priceForMargin,
} from '../supabase/functions/_shared/priceTarget.ts'

const uzs = (value) => value * 100
const FEES = { commission_percent: 30, returns_reserve_percent: 40, fulfillment_tiyin: uzs(5_500) }
const COST = uzs(18_000)

// --- Цена под маржу — та же формула, что даёт пол, с другой целью на входе ------------------

assert.equal(priceForMargin(COST, 20, FEES), uzs(47_000), '(18000 + 5500) / (1 - 0.30 - 0.20) = 47 000')
assert.equal(priceForMargin(COST, 30, FEES), uzs(58_750), 'цель выше — цена выше')
// Комиссия вместе с целью съедает всю цену: такой цены не существует, и отказ честнее числа.
assert.equal(priceForMargin(COST, 70, FEES), null, 'no price exists at 30% commission and 70% target')

// --- Маржа ниже минимума: предлагаем целевую, пол едет рядом --------------------------------

const raise = adviceForMargin({
  currentTiyin: uzs(50_000), unitCostTiyin: COST, minMarginPercent: 20, targetMarginPercent: 30, fees: FEES,
})
assert.equal(raise.direction, 'raise')
assert.equal(raise.target_tiyin, uzs(58_750), 'советуем цену под целевую маржу, а не пол')
assert.equal(raise.floor_tiyin, uzs(47_000), 'пол рядом — чтобы было с чем торговаться')
assert.ok(raise.target_tiyin > raise.floor_tiyin, 'рекомендация никогда не ниже пола')
assert.ok(Math.abs(raise.current_margin_percent - 23) < 0.01, 'нынешняя маржа названа честно')

// Совет, не меняющий цену, — не совет.
assert.equal(
  adviceForMargin({ currentTiyin: uzs(70_000), unitCostTiyin: COST, minMarginPercent: 20, targetMarginPercent: 30, fees: FEES }),
  null,
  'товар уже дороже целевой цены — молчим',
)

// --- Застой: цена идёт вниз, но пол её останавливает ----------------------------------------

const clearance = adviceForDeadstock({ currentTiyin: uzs(100_000), unitCostTiyin: COST, minMarginPercent: 20, fees: FEES })
assert.equal(clearance.direction, 'discount')
assert.equal(clearance.target_tiyin, uzs(70_000), 'скидка ограничена тридцатью процентами')
assert.ok(clearance.target_tiyin > clearance.floor_tiyin)

// Пол выигрывает у скидки: распродажа в убыток — это оплаченный убыток плюс освобождение склада.
const floored = adviceForDeadstock({ currentTiyin: uzs(50_000), unitCostTiyin: COST, minMarginPercent: 20, fees: FEES })
assert.equal(floored.target_tiyin, uzs(47_000), 'скидка упирается в пол, а не пробивает его')
assert.ok(floored.target_tiyin >= floored.floor_tiyin, 'никогда ниже пола')

// Товар и так продаётся на пределе — лежит он не из-за цены, и скидка тут не ответ.
assert.equal(
  adviceForDeadstock({ currentTiyin: uzs(40_000), unitCostTiyin: COST, minMarginPercent: 20, fees: FEES }),
  null,
  'пол выше нынешней цены — предлагать нечего',
)

// Ни один совет не опускается ниже пола ни при каких входных данных.
for (const price of [5_000, 20_000, 47_001, 60_000, 200_000]) {
  for (const advice of [
    adviceForMargin({ currentTiyin: uzs(price), unitCostTiyin: COST, minMarginPercent: 20, targetMarginPercent: 30, fees: FEES }),
    adviceForDeadstock({ currentTiyin: uzs(price), unitCostTiyin: COST, minMarginPercent: 20, fees: FEES }),
  ]) {
    if (advice) assert.ok(advice.target_tiyin >= advice.floor_tiyin, `пол пробит при цене ${price}`)
  }
}

// --- Сообщение ------------------------------------------------------------------------------
// Число, которое переносят в кабинет, стоит отдельной строкой и без разметки: его выделяют
// пальцем на телефоне, и любой символ рядом уедет в буфер вместе с ним.

const text = adviceMessage('Женский бони Молочный', raise)
assert.ok(text.includes('<code>58750</code>'), 'копируемое число — голые цифры, без разделителей')
// Неразрывный пробел из toLocaleString уехал бы вместе с числом в поле цены Uzum.
assert.ok(/<code>\d+<\/code>/.test(text), 'в копируемом числе нет ни пробела, ни неразрывного пробела')
assert.ok(/Ниже не опускаться: 47.000 сум/.test(text), 'пол назван в сообщении')
assert.ok(/Nemo не меняет цену на Uzum/.test(text), 'read-only сказано вслух, а не подразумевается')
assert.ok(!/\*\*/.test(text), 'никакой markdown-разметки: Telegram здесь работает в HTML')

console.log('[OK] Price target behaviour: 22 assertions')
