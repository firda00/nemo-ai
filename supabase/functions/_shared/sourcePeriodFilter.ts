import { detectMarginHeader, marginRowRole } from './productMargin.ts'
import { isSourceDateHeader, sourceCellDate, type DocumentPeriod } from './calendarPeriod.ts'
import type { XlsxSheet } from './xlsxIngest.ts'
export interface PeriodSource { id: string; data: { format: 'xlsx'; dateSystem?: '1900' | '1904'; sheets: XlsxSheet[] } }

export interface PeriodIssue {
  sourceId: string; sheet: string; row?: number; columns?: string[]
  reason: 'missing_date_column' | 'ambiguous_date_column' | 'invalid_date'
}
export interface PeriodRowEvidence {
  sheet: string; row?: number; column?: string; raw?: string; date?: string
  decision: 'included' | 'outside_period' | 'summary' | 'unrecognized_sheet'
}
export function filterSourcePeriod(source: PeriodSource, period: DocumentPeriod) {
  if (source.data.format !== 'xlsx') throw new Error('xlsx_required')
  const issues: PeriodIssue[] = []
  const audit: PeriodRowEvidence[] = []
  const data = source.data
  let included = 0
  let mapped = 0
  const sheets = data.sheets.map((sheet) => {
    const map = detectMarginHeader(sheet)
    if (!map) { audit.push({ sheet: sheet.name, decision: 'unrecognized_sheet' }); return sheet }
    mapped++
    const header = sheet.rows.find((r) => r.rowIndex === map.headerRowIndex)!
    const columns = Object.entries(header.cells).filter(([, c]) => isSourceDateHeader(c.value)).map(([col]) => col)
    const rows = sheet.rows.filter((row) => {
      if (row.rowIndex <= map.headerRowIndex) return true
      const role = marginRowRole(row, map)
      if (role === 'blank') return true
      if (role === 'summary') { audit.push({ sheet: sheet.name, row: row.rowIndex, decision: 'summary' }); return true }
      if (columns.length !== 1) return false
      const column = columns[0]
      const cell = row.cells[column]
      const date = sourceCellDate(cell, data.dateSystem)
      if (!date) { issues.push({ sourceId: source.id, sheet: sheet.name, row: row.rowIndex, columns, reason: 'invalid_date' }); return false }
      const selected = period.from <= date && date <= period.to
      audit.push({ sheet: sheet.name, row: row.rowIndex, column, raw: cell.value, date, decision: selected ? 'included' : 'outside_period' })
      if (selected) included++
      return selected
    })
    if (columns.length !== 1 && sheet.rows.some((row) => row.rowIndex > map.headerRowIndex && marginRowRole(row, map) === 'data')) {
      issues.push({ sourceId: source.id, sheet: sheet.name, row: map.headerRowIndex, columns, reason: columns.length ? 'ambiguous_date_column' : 'missing_date_column' })
    }
    return { ...sheet, rows }
  })
  return { sheets, audit, issues, included, mapped }
}
