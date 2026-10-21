import type { XlsxCell } from './xlsxIngest.ts'
// Calendar days only. Neither locale guessing nor the machine's time zone participates.
export function isCalendarDate(value: string): boolean {
  if (typeof value !== 'string' || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
export interface DocumentPeriod { from: string; to: string }
/** Immutable occurrence date, not the clock on a delayed delivery attempt. */
export function monthlyReportPeriod(month: string, dueDate: string): DocumentPeriod | null {
  if (typeof month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) || !isCalendarDate(dueDate) || dueDate.slice(0, 7) !== month) return null
  return { from: `${month}-01`, to: dueDate }
}
export function sourceCellDate(cell: XlsxCell | undefined, dateSystem?: '1900' | '1904'): string | null {
  if (!cell || cell.kind === 'error' || cell.kind === 'boolean') return null
  const numeric = cell.kind === 'number' || (cell.kind === 'formula-cached' && cell.cachedType === 'number')
  // Old cached snapshots did not retain the formula result type: never guess it.
  if (cell.kind === 'formula-cached' && (!cell.cachedType || cell.cachedType === 'boolean')) return null
  const raw = cell.value.trim()
  if (numeric) {
    if (!dateSystem || !/^\d+(?:\.\d+)?$/.test(raw)) return null
    // Take the integer substring, not Math.floor(Number(raw)): rounding a long fractional
    // part can otherwise move a value to the next day at a period boundary.
    const day = Number(raw.split('.')[0])
    if (!Number.isSafeInteger(day) || day > 2958465 || day < (dateSystem === '1900' ? 1 : 0) || (dateSystem === '1900' && day === 60)) return null
    const epoch = dateSystem === '1904' ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)
    const date = new Date(epoch + (day - (dateSystem === '1900' && day > 60 ? 1 : 0)) * 86400000).toISOString().slice(0, 10)
    return isCalendarDate(date) ? date : null
  }
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw)
  const date = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : raw
  return isCalendarDate(date) ? date : null
}

// An exact header declares which calendar date is meant. Multiple candidate columns
// (e.g. sale date and payment date) need source clarification, not a silent preference.
const DATE_HEADERS = new Set(['date', 'transaction date', 'sale date', 'sales date', 'order date', 'payment date', 'дата', 'дата операции', 'дата продажи', 'дата заказа', 'дата оплаты', 'sana', 'operatsiya sanasi', 'sotuv sanasi', 'buyurtma sanasi', 'to‘lov sanasi', "to'lov sanasi"])
export function isSourceDateHeader(value: string): boolean {
  return DATE_HEADERS.has(value.trim().toLowerCase().replace(/\s+/g, ' '))
}
