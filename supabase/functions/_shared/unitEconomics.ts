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
// stock and can be sold again. What is actually lost is the shipping, twice, and the sale that
// did not happen. At a 5% return rate the difference rounds away; on this Uzum catalogue, where
// 341 sales came with 171 returns, it reported 128 of 140 SKUs as loss-making when they were not.
//
// The model below is per unit the seller ultimately SELLS. For a return rate r, each sale drags
// r/(1-r) returned shipments along with it, and each of those pays the fulfillment fee again.

export type Fees = {
  commission_percent: number
  returns_reserve_percent: number
  fulfillment_tiyin: number
}

/**
 * How many extra fulfillment fees one returned unit costs.
 *
 * ASSUMPTION, not an observed tariff. Uzum's published tariff page states the outbound fee; what
 * it charges to bring a refused parcel back is not in anything Nemo has read — the seller's
 * captured tariff page rendered as a "please enable JavaScript" placeholder and carried no
 * numbers. One is the conservative reading: a return costs what a delivery costs. If the real
 * tariff turns out to be lower (or free), this constant is the only line that changes.
 */
export const RETURN_FEE_MULTIPLIER = 1

/**
 * Above this return rate the arithmetic stops being informative — at r = 1 every unit comes back
 * and the fee per completed sale is infinite. The SKU is unsellable well before that, and a
 * finite ceiling keeps a bad number from becoming a NaN that silently disables an alert.
 */
const RETURN_RATE_CEILING = 0.95

const returnRate = (fees: Fees) => Math.min(Math.max(fees.returns_reserve_percent, 0) / 100, RETURN_RATE_CEILING)

/**
 * Percentage of the selling price consumed by marketplace percentages.
 *
 * Commission only. Uzum charges it on completed sales and refunds it with the order, so a return
 * does not leave commission behind — it leaves shipping behind, which is counted in tiyin below.
 */
const percentageLoad = (fees: Fees) => fees.commission_percent

/**
 * Fulfillment actually paid per COMPLETED sale: the outbound shipment, plus the shipments for
 * every unit that had to come back before this one stuck.
 */
export function effectiveFulfillmentTiyin(fees: Fees): number {
  const r = returnRate(fees)
  return fees.fulfillment_tiyin * ((1 + RETURN_FEE_MULTIPLIER * r) / (1 - r))
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
