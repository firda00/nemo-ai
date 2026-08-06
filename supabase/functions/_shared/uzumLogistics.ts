// Uzum's logistics fee, computed from the published tariff rather than guessed.
//
// Source: seller.uzum.uz/manual/3.tariffs, "Логистический сбор с 01.06.2026". The rate is a
// step function of volume, and volume comes from the dimensions Uzum itself returns on every
// SKU — so this is arithmetic on facts, not an estimate.
//
// The table is dated on purpose: when Uzum changes it, this constant is the one place to edit,
// and EFFECTIVE_FROM tells a future reader which version they are looking at.

export const LOGISTICS_TARIFF = {
  effectiveFrom: '2026-06-01',
  baseTiyin: 5_250_00, // up to and including 1 litre
  perExtraLitreTiyin: 250_00,
  maxTiyin: 50_000_00,
  /** A SKU with no declared dimensions is charged the maximum. */
  withoutDimensionsTiyin: 50_000_00,
} as const

export type SkuDimension = {
  length?: number | null
  width?: number | null
  height?: number | null
  weight?: number | null
}

/** Millimetres to litres, rounded UP to a whole litre exactly as the tariff specifies. */
export function volumeLitres(dimension: SkuDimension | null | undefined): number | null {
  const l = Number(dimension?.length)
  const w = Number(dimension?.width)
  const h = Number(dimension?.height)
  if (![l, w, h].every((v) => Number.isFinite(v) && v > 0)) return null
  return Math.ceil((l * w * h) / 1_000_000)
}

/**
 * Returns the fee in tiyin, or the "no dimensions" rate when the SKU does not declare them.
 * Never returns null: every sold unit is charged something, and silently omitting the fee
 * would overstate margin on exactly the products whose data is weakest.
 */
export function fulfillmentTiyin(dimension: SkuDimension | null | undefined): number {
  const litres = volumeLitres(dimension)
  if (litres === null) return LOGISTICS_TARIFF.withoutDimensionsTiyin
  const fee = LOGISTICS_TARIFF.baseTiyin + Math.max(0, litres - 1) * LOGISTICS_TARIFF.perExtraLitreTiyin
  return Math.min(fee, LOGISTICS_TARIFF.maxTiyin)
}
