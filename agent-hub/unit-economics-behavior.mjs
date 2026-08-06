import assert from 'node:assert/strict'
import {
  RETURN_FEE_MULTIPLIER,
  batchOutcome,
  effectiveFulfillmentTiyin,
  marginPercent,
  maxPurchaseCostTiyin,
  minSellingPriceTiyin,
  netProfitTiyin,
} from '../supabase/functions/_shared/unitEconomics.ts'

const uzs = (value) => value * 100

// The SKU that exposed the bug: a hijab at 90 000 sum, 30% commission, cost guessed at half of
// retail, 5 500 sum logistics, and a return rate of 50% that the shop really does have.
const hijab = { price: uzs(90_000), cost: uzs(45_000) }
const fees = { commission_percent: 30, returns_reserve_percent: 50, fulfillment_tiyin: uzs(5_500) }

// Subtracting the reserve as a share of the price called this SKU a 36% loss-maker.
const wrong = hijab.price - hijab.cost - fees.fulfillment_tiyin - (hijab.price * (30 + 50)) / 100
assert.ok(wrong / hijab.price * 100 < -30, 'the old model really did report a heavy loss')

// A return costs shipping, not the retail price. Half the units coming back means each completed
// sale carries one returned shipment with it: 5 500 out, 5 500 back, 5 500 out again.
assert.equal(Math.round(effectiveFulfillmentTiyin(fees)), uzs(16_500), 'r=50% doubles-and-adds the fee')
const margin = marginPercent(hijab.price, hijab.cost, fees)
assert.ok(margin > 1 && margin < 3, `the hijab is thin but not a loss-maker, got ${margin}`)

// Zero returns must reduce to the plain fee, so nothing changes for a SKU that never comes back.
const clean = { commission_percent: 30, returns_reserve_percent: 0, fulfillment_tiyin: uzs(5_500) }
assert.equal(effectiveFulfillmentTiyin(clean), uzs(5_500))
assert.equal(
  netProfitTiyin(hijab.price, hijab.cost, clean),
  hijab.price - hijab.cost - uzs(5_500) - (hijab.price * 30) / 100,
  'with no returns the model is the plain one',
)

// Returns still cost real money — the model must not have become a way to ignore them.
assert.ok(
  netProfitTiyin(hijab.price, hijab.cost, fees) < netProfitTiyin(hijab.price, hijab.cost, clean),
  'a 50% return rate must still hurt',
)

// Commission is refunded with the order, so it is charged on completed sales only. Doubling the
// return rate must not change the commission the seller ultimately pays per sale.
const feeless = (r) => ({ commission_percent: 30, returns_reserve_percent: r, fulfillment_tiyin: 0 })
assert.equal(
  netProfitTiyin(hijab.price, hijab.cost, feeless(10)),
  netProfitTiyin(hijab.price, hijab.cost, feeless(60)),
  'with no shipping cost, the return rate cannot move the margin',
)

// The floor price and the margin must agree: setting the price to the floor yields exactly the
// minimum margin. This is the contradiction the shared module exists to prevent.
const floor = minSellingPriceTiyin(hijab.cost, 20, fees)
assert.ok(floor > 0)
assert.ok(Math.abs(marginPercent(floor, hijab.cost, fees) - 20) < 0.01, 'the floor must clear exactly the floor')

// Same for the inverse: paying the maximum purchase price yields exactly the target margin.
const maxCost = maxPurchaseCostTiyin(uzs(300_000), 20, fees)
assert.ok(maxCost > 0)
assert.ok(Math.abs(marginPercent(uzs(300_000), maxCost, fees) - 20) < 0.01, 'max purchase price must hit the target')

// A price the marketplace's own cut already consumes has no answer, not a negative one.
assert.equal(maxPurchaseCostTiyin(uzs(300_000), 75, fees), null, '30% commission + 75% target leaves nothing')
assert.equal(minSellingPriceTiyin(hijab.cost, 71, fees), null, 'an impossible target must not return a price')

// An unsellable return rate must produce a finite, terrible number rather than NaN or Infinity —
// a NaN would compare false against the minimum margin and silently withhold the alert.
const doomed = { commission_percent: 30, returns_reserve_percent: 100, fulfillment_tiyin: uzs(5_500) }
const doomedMargin = marginPercent(hijab.price, hijab.cost, doomed)
assert.ok(Number.isFinite(doomedMargin) && doomedMargin < -100, `must stay finite and awful, got ${doomedMargin}`)
assert.ok(Number.isFinite(effectiveFulfillmentTiyin(doomed)))

// ROI is still profit over cash out, and cash out is one unit cost per unit sold: returned goods
// come back to stock rather than being bought again.
const batch = batchOutcome(100, hijab.price, hijab.cost, fees)
assert.equal(batch.investment_tiyin, 100 * hijab.cost)
assert.equal(batch.profit_tiyin, Math.round(100 * netProfitTiyin(hijab.price, hijab.cost, fees)))
assert.ok(batch.roi_percent > 0 && batch.roi_percent < 10, `thin margin means thin ROI, got ${batch.roi_percent}`)

// The one unconfirmed input is a named constant, so a corrected tariff is a one-line change.
assert.equal(RETURN_FEE_MULTIPLIER, 1, 'a return is assumed to cost one more shipment until Uzum says otherwise')

console.log('[OK] Unit economics behaviour: 18 assertions')
