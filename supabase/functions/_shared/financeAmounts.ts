// Parse explicit decimals without floating point multiplication or silent rounding.
// One dot/comma is the decimal separator; optional spaces group integer digits by three.
export function financeAmountMinor(value: unknown, scale = 100): number | null {
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1000) return null
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'number' && !Number.isFinite(value)) return null
  const raw = String(value).trim().replace(/\u00a0|\u202f/g, ' ')
  const match = /^([+-]?)(\d+|\d{1,3}(?: \d{3})+)(?:[.,](\d+))?$/.exec(raw)
  if (!match || raw.length > 100) return null
  const fraction = match[3] ?? ''
  const denominator = 10n ** BigInt(fraction.length)
  const scaled = BigInt(match[2].replace(/ /g, '') + fraction) * BigInt(scale)
  if (scaled % denominator !== 0n) return null
  const amount = scaled / denominator * (match[1] === '-' ? -1n : 1n)
  return amount < -BigInt(Number.MAX_SAFE_INTEGER) || amount > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(amount)
}

export class FinanceCalculationError extends Error {
  readonly code: 'AMOUNT_OVERFLOW' | 'REPORT_LIMIT_EXCEEDED'
  constructor(code: 'AMOUNT_OVERFLOW' | 'REPORT_LIMIT_EXCEEDED') { super(code); this.code = code; this.name = 'FinanceCalculationError' }
}
export function financeSafeSum(values: Iterable<number>): number {
  let sum = 0n
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new FinanceCalculationError('AMOUNT_OVERFLOW')
    sum += BigInt(value)
  }
  if (sum < -BigInt(Number.MAX_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER)) throw new FinanceCalculationError('AMOUNT_OVERFLOW')
  return Number(sum)
}
