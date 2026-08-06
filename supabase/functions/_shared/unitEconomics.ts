// The single definition of unit economics for the whole platform.
//
// Price Guard, the purchase planner and every calculator import from here on purpose. When a
// calculator and an alert each carry their own algebra they eventually disagree, and the
// seller meets the contradiction: the tool says "minimum price 128 000", they set exactly
// that, and the next digest warns their margin is below the floor.
//
// Margin is defined as net profit over SELLING PRICE (not over cost). Commission and the
// returns reserve are percentages OF the selling price; unit cost and fulfillment are
// absolute amounts. Everything is in tiyin, because money is never a float here.

export type Fees = {
  commission_percent: number
  returns_reserve_percent: number
  fulfillment_tiyin: number
}

/** Percentage of the selling price consumed by marketplace percentages. */
const percentageLoad = (fees: Fees) => fees.commission_percent + fees.returns_reserve_percent

export function netProfitTiyin(priceTiyin: number, unitCostTiyin: number, fees: Fees): number {
  return priceTiyin - unitCostTiyin - fees.fulfillment_tiyin - (priceTiyin * percentageLoad(fees)) / 100
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
  const value = (priceTiyin * (100 - load)) / 100 - fees.fulfillment_tiyin
  return value > 0 ? Math.round(value) : null
}

/**
 * The lowest retail price that still clears a minimum margin. This is the inverse of
 * maxPurchaseCost, and Price Guard's floor.
 */
export function minSellingPriceTiyin(unitCostTiyin: number, minMarginPercent: number, fees: Fees): number | null {
  const load = percentageLoad(fees) + minMarginPercent
  if (load >= 100) return null
  const value = ((unitCostTiyin + fees.fulfillment_tiyin) * 100) / (100 - load)
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
