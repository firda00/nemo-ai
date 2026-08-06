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

// Uzum bills commission and logistics only on goods actually sold, per sold unit at handover, and
// that one fee already covers sending a returned item back and re-listing it. So the fee per
// completed sale is the plain fee, whatever the return rate.
assert.equal(effectiveFulfillmentTiyin(fees), uzs(5_500), 'a return is not billed a second fee')
const margin = marginPercent(hijab.price, hijab.cost, fees)
assert.ok(margin > 13.5 && margin < 14, `the hijab clears a real margin, got ${margin}`)

// The return rate must not move the margin at all — that is the whole content of the tariff.
const clean = { commission_percent: 30, returns_reserve_percent: 0, fulfillment_tiyin: uzs(5_500) }
assert.equal(
  netProfitTiyin(hijab.price, hijab.cost, fees),
  netProfitTiyin(hijab.price, hijab.cost, clean),
  'a 50% return rate and a 0% one must produce the same margin per sale',
)
assert.equal(
  netProfitTiyin(hijab.price, hijab.cost, clean),
  hijab.price - hijab.cost - uzs(5_500) - (hijab.price * 30) / 100,
  'the model is price less commission, cost and one fee',
)

// The rate is still carried, still stored and still shown — it just answers a different question.
// If Uzum ever starts billing returns, one constant turns it back into a margin cost.
assert.equal(RETURN_FEE_MULTIPLIER, 0, 'per Uzum tariff 3.2 a returned unit is billed nothing')
const billed = (r) => uzs(5_500) * (1 + 1 * (r / (1 - r)))
assert.equal(billed(0.5), uzs(11_000), 'were returns billed, half of them would double the fee per sale')

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

// A 100% return rate must not produce NaN or Infinity anywhere: a NaN compares false against the
// minimum margin, so it would withhold the alert rather than raise it.
const doomed = { commission_percent: 30, returns_reserve_percent: 100, fulfillment_tiyin: uzs(5_500) }
assert.ok(Number.isFinite(marginPercent(hijab.price, hijab.cost, doomed)))
assert.ok(Number.isFinite(effectiveFulfillmentTiyin(doomed)))
assert.ok(Number.isFinite(minSellingPriceTiyin(hijab.cost, 20, doomed)))

// ROI is still profit over cash out, and cash out is one unit cost per unit sold: returned goods
// come back to stock rather than being bought again.
const batch = batchOutcome(100, hijab.price, hijab.cost, fees)
assert.equal(batch.investment_tiyin, 100 * hijab.cost)
assert.equal(batch.profit_tiyin, Math.round(100 * netProfitTiyin(hijab.price, hijab.cost, fees)))
assert.ok(batch.roi_percent > 27 && batch.roi_percent < 28, `ROI is profit over cash out, got ${batch.roi_percent}`)

console.log('[OK] Unit economics behaviour: 17 assertions')
