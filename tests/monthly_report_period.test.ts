import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { periodXlsx, sourceXlsx } from './fixtures/document-source-fixtures'
import { parseSourceXlsx, MONTHLY_XLSX_LIMITS } from '../supabase/functions/_shared/xlsxSource'
import { monthlyReportPeriod } from '../supabase/functions/_shared/calendarPeriod'
import { buildProductReportDocument } from '../supabase/functions/_shared/reminderWorker'

const edit = (bytes: Uint8Array, file: string, mutate: (xml: string) => string) => {
  const parts = unzipSync(bytes); parts[file] = strToU8(mutate(strFromU8(parts[file]))); return zipSync(parts)
}
const build = (bytes = periodXlsx(), due_date = '2026-07-30') => buildProductReportDocument(bytes, {
  file_sha256: createHash('sha256').update(bytes).digest('hex'), file_name: 'sales.xlsx', period_month: due_date.slice(0, 7),
  uploaded_at: '2026-07-20T10:00:00Z', currency: 'USD', occurrenceId: 'occ-monthly', title: 'Отчёт 30-го', due_date,
})
const valuesOf = (bytes: Uint8Array) => parseSourceXlsx(bytes, MONTHLY_XLSX_LIMITS).sheets.flatMap((s) => s.rows.flatMap((r) => Object.values(r.cells).map((c) => c.value)))

describe('monthly report date filtering', () => {
  test('scheduled calendar day is the immutable inclusive cutoff, including leap months', () => {
    for (const date of ['2026-07-30', '2026-07-31', '2026-02-28', '2028-02-29']) expect(monthlyReportPeriod(date.slice(0, 7), date)).toEqual({ from: `${date.slice(0, 7)}-01`, to: date })
    for (const date of ['2026-02-29', '2026-02-30', '2026-08-01', '2026-07-30T00:00:00Z']) expect(monthlyReportPeriod('2026-07', date)).toBeNull()
    expect(monthlyReportPeriod('0000-07', '0000-07-01')).toBeNull()
  })
  test('30th excludes the 31st; real workbook includes audit and exact source row JSON', () => {
    const source = periodXlsx()
    const result = build(source)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const workbook = parseSourceXlsx(result.xlsx, MONTHLY_XLSX_LIMITS)
    expect(workbook.sheets.map((s) => s.name)).toEqual(['Margin', 'Products', 'Gaps', 'Date audit', 'Source data'])
    const margin = workbook.sheets[0]
    const total = margin.rows.find((r) => r.cells.A?.value === 'totals')!
    expect([total.cells.E.value, total.cells.F.value, total.cells.G.value]).toEqual(['100', '20', '80'])
    const values = valuesOf(result.xlsx)
    for (const value of ['2026-07-01', '2026-07-30', 'outside_period', '31.07.2026', 'not_verified', 'occ-monthly']) expect(values).toContain(value)
    const original = parseSourceXlsx(source)
    const retained = workbook.sheets.find((s) => s.name === 'Source data')!
    for (const sheet of original.sheets) for (const row of sheet.rows) {
      const parts = retained.rows.filter((r) => r.cells.A?.value === sheet.name && r.cells.B?.value === String(row.rowIndex))
      expect(JSON.parse(parts.map((r) => r.cells.F?.value ?? '').join(''))).toEqual(row.cells)
    }
  })
  test('31st includes the last day; missing/invalid dates and empty periods refuse visibly', () => {
    const full = build(periodXlsx(), '2026-07-31')
    if (!full.ok) throw new Error(full.reason)
    expect(valuesOf(full.xlsx)).toContain('290')
    expect(build(periodXlsx({ invalidDate: true }))).toEqual({ ok: false, reason: 'needs_source_dates' })
    expect(build(sourceXlsx())).toEqual({ ok: false, reason: 'needs_source_dates' })
    expect(build(periodXlsx(), '2025-07-30')).toEqual({ ok: false, reason: 'no_rows_period' })
    expect(build(new Uint8Array([0, 1]))).toEqual({ ok: false, reason: 'source_unreadable' })
  })
  test('long non-financial source cells split without losing astral characters or formula-like text', () => {
    const value = '=WEBSERVICE("https://example.invalid")\r' + '😀'.repeat(20000)
    const xmlValue = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\r/g, '&#13;')
    const source = edit(periodXlsx(), 'xl/worksheets/sheet1.xml', (xml) => xml.replace('<row r="6">', `<row r="6"><c r="G6" t="inlineStr"><is><t>${xmlValue}</t></is></c>`))
    const result = build(source)
    if (!result.ok) throw new Error(result.reason)
    const workbook = parseSourceXlsx(result.xlsx, MONTHLY_XLSX_LIMITS)
    const parts = workbook.sheets.find((s) => s.name === 'Source data')!.rows.filter((r) => r.cells.A?.value === 'Продажи' && r.cells.B?.value === '6')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((r) => r.cells.F.value.length <= 32000)).toBe(true)
    expect(JSON.parse(parts.map((r) => r.cells.F.value).join('')).G.value).toBe(value)
    expect(Object.values(unzipSync(result.xlsx)).some((v) => /<f[ >]/.test(strFromU8(v)))).toBe(false)
  })
  test('monthly profile accepts more than the chat row cap; limits refuse without truncation', () => {
    const extra = Array.from({ length: 2200 }, (_, i) => `<row r="${i + 10}"><c r="A${i + 10}" t="inlineStr"><is><t>P${i}</t></is></c><c r="C${i + 10}"><v>10</v></c><c r="D${i + 10}"><v>6</v></c><c r="F${i + 10}" t="inlineStr"><is><t>2026-07-12</t></is></c></row>`).join('')
    const source = edit(periodXlsx(), 'xl/worksheets/sheet1.xml', (xml) => xml.replace('</sheetData>', extra + '</sheetData>'))
    expect(() => parseSourceXlsx(source)).toThrow('too_large')
    expect(parseSourceXlsx(source, MONTHLY_XLSX_LIMITS).sheets[0].rows).toHaveLength(2207)
    expect(() => parseSourceXlsx(source, { ...MONTHLY_XLSX_LIMITS, rowsPerSheet: 2206 })).toThrow('too_large')
    expect(build(source).ok).toBe(true)
  })
  test('streaming reader handles prefixes/shared caches and rejects missing or ambiguous dates', () => {
    const source = sourceXlsx({ prefix: true, singleQuotes: true })
    expect(parseSourceXlsx(source).sheets).toHaveLength(2)
    const duplicate = edit(periodXlsx(), 'xl/worksheets/sheet1.xml', (xml) => xml.replace('<row r="4">', '<row r="4"><c r="G4" t="inlineStr"><is><t>Дата оплаты</t></is></c>'))
    expect(build(duplicate)).toEqual({ ok: false, reason: 'needs_source_dates' })
    const badFlag = periodXlsx({ date1904: '' })
    expect(build(badFlag)).toEqual({ ok: false, reason: 'source_incomplete' })
  })
  test('malformed scalar and rich-text containers refuse instead of inventing concatenated values', () => {
    for (const replacement of [
      '<c r="F6" t="inlineStr"><is><t>2026-07-<discard>31</discard>01</t></is></c>',
      '<c r="F6" t="inlineStr"><is><t>2026-07-</t></is><is><t>01</t></is></c>',
      '<c r="F6" t="inlineStr"><is><discard>2030-12-31</discard><t>2026-07-01</t></is></c>',
      '<c r="F6" t="inlineStr"><is><r><t>2026-07-</t><t>01</t></r></is></c>',
      '<c r="F6"><v>46<discard>999</discard>204</v></c>',
      '<c r="F6" t="inlineStr"><is>2030-12-31<t>2026-07-01</t></is></c>',
      '<c r="F6" t="inlineStr"><is><r><rPr><r><t>31</t></r></rPr><t>2026-07-01</t></r></is></c>',
      '<c r="F6" t="inlineStr"><is><r><rPr>31</rPr><t>2026-07-01</t></r></is></c>',
      '<c r="F6" t="inlineStr"><is><r><rPr><b>31</b></rPr><t>2026-07-01</t></r></is></c>',
      '<c r="F6" t="inlineStr"><is><r><rPr><b><discard>31</discard></b></rPr><t>2026-07-01</t></r></is></c>',
      '<c r="F6" t="inlineStr"><is><r><t>2026-07-</t></r><t>01</t></is></c>',
    ]) {
      const source = edit(periodXlsx(), 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="F6"[\s\S]*?<\/c>/, replacement))
      expect(build(source)).toEqual({ ok: false, reason: 'source_incomplete' })
    }
    const formatted = edit(periodXlsx(), 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="F6"[\s\S]*?<\/c>/, '<c r="F6" t="inlineStr"><is><r><rPr><b/><color rgb="FF112233"/><sz val="11"/></rPr><t>2026-07-</t></r><r><t>01</t></r></is></c>'))
    expect(build(formatted).ok).toBe(true)
  })
})
