import { z } from 'zod'
import { isCalendarDate } from './calendarPeriod.ts'

// Finance intervals compare absolute instants. Sub-millisecond input is refused rather
// than rounded across a boundary. Calendar-only imports explicitly mean Tashkent midnight.
export function isFinanceInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value)
  return !!match && isCalendarDate(match[1]) && Number.isFinite(Date.parse(value))
}
export const FinanceInstantSchema = z.string().refine(isFinanceInstant, 'use a valid ISO timestamp with explicit offset and at most 3 fractional digits')
export const FinancePeriodSchema = z.object({ from: FinanceInstantSchema, to: FinanceInstantSchema }).strict().refine(
  value => Date.parse(value.from) < Date.parse(value.to), 'period.from must be before period.to',
)

export function financeImportDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (isFinanceInstant(raw)) return raw
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw)
  const day = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : raw
  return isCalendarDate(day) ? `${day}T00:00:00+05:00` : null
}

export function financeCalendarPeriod(value: string, kind: 'month' | 'day'): { from: string; to: string } | null {
  const day = kind === 'month' ? `${value}-01` : value
  if (!isCalendarDate(day)) return null
  const next = new Date(`${day}T00:00:00Z`)
  if (kind === 'month') next.setUTCMonth(next.getUTCMonth() + 1)
  else next.setUTCDate(next.getUTCDate() + 1)
  const result = { from: `${day}T00:00:00+05:00`, to: `${next.toISOString().slice(0, 10)}T00:00:00+05:00` }
  return FinancePeriodSchema.safeParse(result).success ? result : null
}
