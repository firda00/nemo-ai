// The single definition of unit economics for the whole platform.
//
// Price Guard, the purchase planner and every calculator import from here on purpose. When a
// calculator and an alert each carry their own algebra they eventually disagree, and the
// seller meets the contradiction: the tool says "minimum price 128 000", they set exactly
// that, and the next digest warns their margin is below the floor.
//
// Margin is defined as net profit over SELLING PRICE (not over cost). Commission is a percentage
// of the selling price; unit cost and fulfillment are absolute amounts. Everything is in tiyin,
// because money is never a float here.
//
// A RETURN IS NOT A LOST SALE PRICE. The first version subtracted the return reserve the same way
// it subtracted commission — as a percentage of the price — which says a returned unit costs the
// seller its full retail value. It does not: the customer is refunded, the goods come back to
// stock and can be sold again. At a 5% return rate the difference rounds away; on this Uzum
// catalogue, where 341 sales came with 171 returns, it reported 128 of 140 SKUs as loss-making
// when they were not.
//
// Uzum's §3.2 settles what a return actually costs: nothing. Commission and the logistics fee are
// withheld only from the revenue of goods sold, per sold unit at handover, and the fee already
// includes servicing a return — carriage back to the warehouse and putting the item on sale again.
//
// So the model below is per unit the seller ultimately SELLS, and the return rate does not enter
// it. That rate is still real and still stored: it says how much stock must move to produce one
// sale, which is a question about inventory and cash, not about margin.

export type Fees = {
  commission_percent: number
  returns_reserve_percent: number
  fulfillment_tiyin: number
}

/**
 * What one returned unit costs, as a share of the fulfillment fee.
 *
 * ZERO, and that is the tariff talking, not an estimate. Uzum's §3.2 states that commission and
 * the logistics fee are withheld only from the revenue of goods actually sold, charged per sold
 * unit at the moment it is handed over — and that the fee already covers servicing a buyer's
 * return, including carriage back to the warehouse and putting the item back on sale.
 *
 * So a return is not billed at all: no commission, no fee, and the goods return to stock. This
 * constant is what changes if that ever stops being true.
 */
export const RETURN_FEE_MULTIPLIER = 0

/**
 * Above this return rate the arithmetic stops being informative — at r = 1 nothing is ever sold
 * and there is no per-sale figure to state. Only reachable while RETURN_FEE_MULTIPLIER is above
 * zero, but the clamp stays: a NaN would compare false against the minimum margin and silently
 * withhold the alert instead of raising it.
 */
const RETURN_RATE_CEILING = 0.95

const returnRate = (fees: Fees) => Math.min(Math.max(fees.returns_reserve_percent, 0) / 100, RETURN_RATE_CEILING)

/**
 * Percentage of the selling price consumed by marketplace percentages.
 *
 * Commission only, and only on sales that completed — Uzum withholds it from the revenue of sold
 * goods, so a returned unit leaves no commission behind.
 */
const percentageLoad = (fees: Fees) => fees.commission_percent

/**
 * Fulfillment actually paid per COMPLETED sale: the fee for this sale, plus whatever the returned
 * units that came with it were billed. Each completed sale drags r/(1-r) returns along, and under
 * the published tariff each of those is billed nothing — so this is the plain fee, and the return
 * rate cannot touch the margin. It still matters everywhere else: it is how much stock has to move
 * to produce one sale.
 */
export function effectiveFulfillmentTiyin(fees: Fees): number {
  const r = returnRate(fees)
  return fees.fulfillment_tiyin * (1 + RETURN_FEE_MULTIPLIER * (r / (1 - r)))
}

export function netProfitTiyin(priceTiyin: number, unitCostTiyin: number, fees: Fees): number {
  return priceTiyin - unitCostTiyin - effectiveFulfillmentTiyin(fees) - (priceTiyin * percentageLoad(fees)) / 100
}

export function marginPercent(priceTiyin: number, unitCostTiyin: number, fees: Fees): number | null {
  if (!(priceTiyin > 0)) return null
  return (netProfitTiyin(priceTiyin, unitCostTiyin, fees) / priceTiyin) * 100
}

/**
 * The most a seller may pay a supplier and still hit a target margin at a given retail price.
 * Returns null when the marketplace's own cut plus the target already consume the whole price:
 * there is no such purchase price, and a negative number dressed up as an answer is worse than
 * saying so.
 */
export function maxPurchaseCostTiyin(priceTiyin: number, targetMarginPercent: number, fees: Fees): number | null {
  if (!(priceTiyin > 0)) return null
  const load = percentageLoad(fees) + targetMarginPercent
  if (load >= 100) return null
  const value = (priceTiyin * (100 - load)) / 100 - effectiveFulfillmentTiyin(fees)
  return value > 0 ? Math.round(value) : null
}

/**
 * The lowest retail price that still clears a minimum margin. This is the inverse of
 * maxPurchaseCost, and Price Guard's floor.
 */
export function minSellingPriceTiyin(unitCostTiyin: number, minMarginPercent: number, fees: Fees): number | null {
  const load = percentageLoad(fees) + minMarginPercent
  if (load >= 100) return null
  const value = ((unitCostTiyin + effectiveFulfillmentTiyin(fees)) * 100) / (100 - load)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export type BatchOutcome = {
  units: number
  investment_tiyin: number
  profit_tiyin: number
  roi_percent: number | null
  margin_percent: number | null
}

/**
 * What a recommended reorder is actually worth. ROI is profit over the money that leaves the
 * seller's pocket (units x unit cost), which is what they compare against other uses of cash —
 * not profit over revenue, which is the margin and a different question.
 *
 * `units` is units SOLD, matching netProfitTiyin. The returned units that came with them are
 * already paid for inside the effective fulfillment fee, and their goods went back into stock —
 * so the cash tied up is still one unit cost per unit sold.
 */
export function batchOutcome(units: number, priceTiyin: number, unitCostTiyin: number, fees: Fees): BatchOutcome | null {
  if (!Number.isFinite(units) || units <= 0) return null
  const investment = Math.round(units * unitCostTiyin)
  const profit = Math.round(units * netProfitTiyin(priceTiyin, unitCostTiyin, fees))
  return {
    units,
    investment_tiyin: investment,
    profit_tiyin: profit,
    roi_percent: investment > 0 ? (profit / investment) * 100 : null,
    margin_percent: marginPercent(priceTiyin, unitCostTiyin, fees),
  }
}

/** True when every input the maths needs is present. Callers must check before computing. */
export function feesComplete(fees: Partial<Fees> | null | undefined): fees is Fees {
  return Boolean(fees)
    && typeof fees!.commission_percent === 'number'
    && typeof fees!.returns_reserve_percent === 'number'
    && typeof fees!.fulfillment_tiyin === 'number'
}
