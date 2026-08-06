/**
 * How much of the price to hold back for returns.
 *
 * Uzum reports `quantitySold` and `quantityReturned` per SKU, so the return rate has a known
 * denominator — and the denominators are often tiny. Taking the raw ratio is what put 83% on a
 * scarf: five returns against six lifetime sales. That figure is arithmetically correct and
 * economically meaningless. It describes six units, not the product, and it turned 98 of 140
 * healthy SKUs into "loss-making" ones.
 *
 * So each rate is pulled toward the rate of a larger population it belongs to: a SKU toward its
 * category, a category toward the whole catalogue. A SKU with hundreds of sales keeps its own
 * rate nearly untouched; one with six borrows almost all of its estimate from its category. The
 * pull is worth exactly PRIOR_UNITS imaginary sales at the population rate, which is why a
 * product only starts speaking for itself once it has sold about that much.
 *
 * There is deliberately no upper cap. A cap would hide a genuinely bad product, and with real
 * denominators the noise this was meant to suppress is already gone.
 */

/** Weight of the population rate, in units. Twenty sales is where a rate stops being an anecdote. */
export const PRIOR_UNITS = 20

export interface ReturnObservation {
  /** Units sold over the SKU's lifetime, as Uzum counts them. */
  sold: number | null
  /** Units returned over the same period. */
  returned: number | null
}

const clean = (value: number | null): number | null =>
  value == null || !Number.isFinite(value) || value < 0 ? null : Math.floor(value)

/** Sums a population into one observation. Unknown counts are skipped, not read as zero. */
export function pool(rows: ReturnObservation[]): ReturnObservation {
  let sold = 0
  let returned = 0
  for (const row of rows) {
    const s = clean(row.sold)
    const r = clean(row.returned)
    if (s == null) continue
    sold += s
    returned += r ?? 0
  }
  return { sold, returned }
}

/** Observed percentage, or null when nothing was sold and there is therefore nothing to observe. */
export function observedRate(row: ReturnObservation): number | null {
  const sold = clean(row.sold)
  if (sold == null || sold === 0) return null
  const returned = Math.min(clean(row.returned) ?? 0, sold)
  return (returned / sold) * 100
}

/**
 * The rate to actually reserve against: the SKU's own history blended with `priorRate` as though
 * the population had already sold PRIOR_UNITS units on this SKU's behalf.
 *
 * Returns null when there is no history and no prior — an unsold SKU in an unsold catalogue is a
 * missing input, and inventing a reserve for it would put a number the owner never gave into
 * their margin.
 */
export function reserveRate(
  row: ReturnObservation,
  priorRate: number | null,
  priorUnits: number = PRIOR_UNITS,
): number | null {
  const sold = clean(row.sold) ?? 0
  const returned = Math.min(clean(row.returned) ?? 0, sold)
  if (priorRate == null) {
    // No population to borrow from: the SKU can only speak for itself, if it has sold anything.
    return observedRate(row)
  }
  const blended = (returned + (priorRate / 100) * priorUnits) / (sold + priorUnits)
  return Math.round(Math.min(blended * 100, 100) * 10) / 10
}

/**
 * Reserves for a whole catalogue in one pass: catalogue rate first, then each category shrunk
 * toward it, then each SKU shrunk toward its own category. Keyed by the caller's own SKU key so
 * this module never needs to know what a SKU row looks like.
 */
export function reservesForCatalogue<K>(
  rows: Array<{ key: K; category: string | null; observation: ReturnObservation }>,
): Map<K, number | null> {
  const catalogueRate = observedRate(pool(rows.map((row) => row.observation)))

  const byCategory = new Map<string, ReturnObservation[]>()
  for (const row of rows) {
    const category = row.category ?? ''
    const bucket = byCategory.get(category)
    if (bucket) bucket.push(row.observation)
    else byCategory.set(category, [row.observation])
  }
  // A category with few sales is itself an anecdote, so it borrows from the catalogue before it
  // lends to its SKUs.
  const categoryRates = new Map<string, number | null>()
  for (const [category, observations] of byCategory) {
    categoryRates.set(category, reserveRate(pool(observations), catalogueRate))
  }

  return new Map(rows.map((row) => [
    row.key,
    reserveRate(row.observation, categoryRates.get(row.category ?? '') ?? catalogueRate),
  ]))
}
