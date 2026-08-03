// Growth target as arithmetic, not as a promise.
//
// The owner asked for "+20% in a week, propose something I can evaluate". A model asked that
// question will happily answer "these three actions will give +20%" — a number with nothing behind
// it. This computes the parts that ARE computable from live store data and draws an explicit line
// around the part that is not.
import assert from 'node:assert/strict'
import { growthPlan, growthPlanBlock } from '../supabase/functions/_shared/growthPlan.ts'

const rows = [
  { sku: 'A-1', name: 'Куртка', price: 400000, stock: 0, units: 30 },   // sold out, live demand
  { sku: 'A-2', name: 'Шапка', price: 90000, stock: 4, units: 12 },     // will sell out in days
  { sku: 'A-3', name: 'Шарф', price: 70000, stock: 50, units: 0 },      // dead stock
  { sku: 'A-4', name: 'Перчатки', price: 60000, stock: 20, units: 8 },  // healthy
  { sku: 'A-5', name: 'Носки', price: null, stock: 10, units: null },   // sales unknown
]
const plan = growthPlan(rows, 20, 7)

// The base excludes the row whose sales are unknown — an unmeasured SKU must not count as zero.
assert.equal(plan.baseUnits, 50, '30 + 12 + 0 + 8, with the unknown row excluded entirely')
assert.equal(plan.targetUnits, 60, '+20% of 50')
assert.equal(plan.gapUnits, 10)

// Recoverable demand is only what is provably being lost right now.
assert.deepEqual(plan.soldOut.map((r) => r.sku), ['A-1'])
assert.equal(plan.recoverableUnits, 30)
assert.equal(plan.remainderUnits, 0, 'recovery already exceeds the gap here')

// The next stockout, still preventable, with cover expressed in days.
assert.deepEqual(plan.lowCover.map((r) => r.sku), ['A-2'])
assert.equal(plan.lowCover[0].coverDays, 2.33, '4 in stock / 12 per week * 7 days')

// Frozen money uses real prices only; a SKU without a price contributes nothing rather than zero.
assert.deepEqual(plan.deadStock.map((r) => r.sku), ['A-3'])
assert.equal(plan.frozenMoney, 3_500_000, '50 * 70000')

// A larger target must widen the uncomputable remainder, not silently absorb it.
const ambitious = growthPlan(rows, 200, 7)
assert.equal(ambitious.targetUnits, 150)
assert.equal(ambitious.gapUnits, 100)
assert.equal(ambitious.remainderUnits, 70, '100 needed, 30 recoverable, 70 need new demand')

// The block must state the boundary, and must forbid inventing promo percentages.
const block = growthPlanBlock(ambitious)
assert.match(block, /посчитано сервером, не моделью/)
assert.match(block, /ГРАНИЦА РАСЧЁТА: пополнение покрывает максимум 30 ед\. из 100/)
assert.match(block, /Оставшиеся 70 ед\. должны прийти из нового спроса/)
assert.match(block, /Не называй проценты роста от промо как факт/)
assert.match(block, /прибыль от скидки не считается — только выручка/,
  'without cost and fees, profit from a discount is not derivable')

// A store with no measurable sales must produce no plan rather than an empty-looking one.
assert.equal(growthPlanBlock(growthPlan([{ sku: 'X', name: 'X', price: null, stock: null, units: null }], 20, 7)), '')

console.log('Growth plan behavior passed.')
