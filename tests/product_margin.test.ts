// Raw-XLSX product-margin stage — offline tests: bounded ingestion (adversarial archives
// included), deterministic margin math, product aggregation, and the three exports (with an
// independent round-trip through our own parser). No network, no LLM.
import { describe, expect, test } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { parseXlsxWorkbook, type XlsxSheet } from '../src/lib/xlsxIngest'
import { computeProductMargin, formatCents, type MarginReport } from '../src/lib/productMargin'
import { marginReportToCsv, marginReportToHtml, marginReportToXlsx } from '../src/lib/marginReportExport'
import { buildProductReportDocument } from '../supabase/functions/_shared/reminderWorker.ts'

// ── fixture builders ─────────────────────────────────────────────────────────────────────────────

const cellXml = (ref: string, value: string | number): string =>
  typeof value === 'number'
    ? `<c r="${ref}"><v>${value}</v></c>`
    : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`

function sheetXmlOf(rows: Array<Array<string | number | null>>): string {
  const body = rows.map((cells, rowIdx) => {
    const cols = 'ABCDEFGH'
    const xml = cells.map((value, colIdx) => value === null ? '' : cellXml(`${cols[colIdx]}${rowIdx + 1}`, value)).join('')
    return `<row r="${rowIdx + 1}">${xml}</row>`
  }).join('')
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

function makeXlsx(sheets: Record<string, string>, extraFiles: Record<string, Uint8Array> = {}): Uint8Array {
  const names = Object.keys(sheets)
  const workbook = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, index) =>
    `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_name, index) =>
    `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(rels),
    ...extraFiles,
  }
  names.forEach((name, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheets[name]) })
  return zipSync(files, { level: 6 })
}

const marginOf = (sheets: Record<string, Array<Array<string | number | null>>>, currency: string | null = 'UZS') => {
  const parsed = parseXlsxWorkbook(makeXlsx(Object.fromEntries(Object.entries(sheets).map(([name, rows]) => [name, sheetXmlOf(rows)]))))
  if (!parsed.ok) throw new Error(`parse failed: ${parsed.reason}`)
  return computeProductMargin(parsed, { currency, fileName: 'test.xlsx', fileSha256: 'deadbeef', now: () => new Date('2026-09-05T03:00:00Z') })
}
const asReport = (result: ReturnType<typeof marginOf>): MarginReport => {
  if (!result.ok) throw new Error(`engine failed: ${result.reason}`)
  return result
}

// patch a 4-byte little-endian size field for a named entry in the LOCAL header or CENTRAL directory
function patchZipSize(archive: Uint8Array, entryName: string, where: 'local' | 'central', newSize: number): Uint8Array {
  const out = new Uint8Array(archive)
  const sig = where === 'local' ? [0x50, 0x4b, 0x03, 0x04] : [0x50, 0x4b, 0x01, 0x02]
  const nameOffset = where === 'local' ? 26 : 28
  const sizeOffset = where === 'local' ? 22 : 24
  const nameBytes = strToU8(entryName)
  for (let i = 0; i < out.length - 4; i += 1) {
    if (out[i] !== sig[0] || out[i + 1] !== sig[1] || out[i + 2] !== sig[2] || out[i + 3] !== sig[3]) continue
    const nameLen = out[i + nameOffset] | (out[i + nameOffset + 1] << 8)
    const nameStart = i + (where === 'local' ? 30 : 46)
    if (nameLen !== nameBytes.length) continue
    let match = true
    for (let j = 0; j < nameLen; j += 1) if (out[nameStart + j] !== nameBytes[j]) { match = false; break }
    if (!match) continue
    const at = i + sizeOffset
    out[at] = newSize & 0xff; out[at + 1] = (newSize >> 8) & 0xff; out[at + 2] = (newSize >> 16) & 0xff; out[at + 3] = (newSize >> 24) & 0xff
    return out
  }
  throw new Error(`entry not found for patch: ${entryName} (${where})`)
}

// ── bounded ingestion ────────────────────────────────────────────────────────────────────────────

describe('parseXlsxWorkbook', () => {
  test('multi-sheet parse: shared strings, rich inline runs, safe entities, provenance', () => {
    const shared = '<sst><si><t>Товар А</t></si><si><r><t>Bold </t></r><r><t>run</t></r></si></sst>'
    const sheet1 = '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>две </t><t>части</t></is></c></row>'
      + '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>42.5</v></c><c r="C3" t="inlineStr"><is><t>&#x110000;&amp;ok&#1076;</t></is></c></row>'
      + '</sheetData></worksheet>'
    const parsed = parseXlsxWorkbook(makeXlsx({ 'Продажи': sheet1, 'Пустой': '<worksheet><sheetData/></worksheet>' }, {
      'xl/sharedStrings.xml': strToU8(shared),
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(['Продажи', 'Пустой'])
    const rows = parsed.sheets[0].rows
    expect(rows[0].cells.A.value).toBe('Товар А')
    expect(rows[0].cells.B.value).toBe('две части') // ALL inline runs, not just the first
    expect(rows[1].rowIndex).toBe(3) // provenance keeps the real row number
    expect(rows[1].cells.A.value).toBe('Bold run')
    expect(rows[1].cells.C.value).toBe('&okд') // invalid codepoint dropped, no throw
  })

  test('formula cells: cached value used verbatim, formula-only rejected as an issue', () => {
    const sheet = '<worksheet><sheetData><row r="1">'
      + '<c r="A1"><f>SUM(B:B)</f><v>150</v></c>'
      + '<c r="B1"><f>EVIL()</f></c>'
      + '</row></sheetData></worksheet>'
    const parsed = parseXlsxWorkbook(makeXlsx({ S: sheet }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.sheets[0].rows[0].cells.A).toMatchObject({ value: '150', kind: 'formula-cached' })
    expect(parsed.sheets[0].rows[0].cells.B).toBeUndefined()
    expect(parsed.issues).toContainEqual({ code: 'formula_without_cached_value', sheet: 'S', rowIndex: 1, cellRef: 'B1' })
  })

  test('a declared rel target that is missing is reported, never remapped to another sheet', () => {
    const workbook = '<workbook><sheets><sheet name="Настоящий" sheetId="1" r:id="rId1"/></sheets></workbook>'
    const rels = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet99.xml"/></Relationships>'
    const parsed = parseXlsxWorkbook(zipSync({
      'xl/workbook.xml': strToU8(workbook),
      'xl/_rels/workbook.xml.rels': strToU8(rels),
      'xl/worksheets/sheet1.xml': strToU8(sheetXmlOf([['чужие данные']])), // an orphan part
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.issues).toContainEqual({ code: 'sheet_part_missing', sheet: 'Настоящий' })
    expect(parsed.sheets).toHaveLength(0) // no silent relabeling of the orphan part
  })

  test('decompression bombs are rejected fast: declared size, entry count, and actual bytes', () => {
    const big = zipSync({ 'xl/workbook.xml': new Uint8Array(25 * 1024 * 1024) }, { level: 9 })
    const started = Date.now()
    expect(parseXlsxWorkbook(big)).toMatchObject({ ok: false, reason: 'entry_too_large' })
    expect(Date.now() - started).toBeLessThan(5_000)

    const manyEntries: Record<string, Uint8Array> = {}
    for (let index = 0; index < 201; index += 1) manyEntries[`f${index}.bin`] = strToU8('x')
    expect(parseXlsxWorkbook(zipSync(manyEntries))).toMatchObject({ ok: false, reason: 'too_many_entries' })
  })

  test('an UNDERSTATED local header size is a lie and rejects; the central directory is never trusted', () => {
    const honest = makeXlsx({ S: sheetXmlOf([['Товар', 'Сумма'], ['A', 100]]) })
    const localLie = patchZipSize(honest, 'xl/worksheets/sheet1.xml', 'local', 5)
    expect(parseXlsxWorkbook(localLie)).toMatchObject({ ok: false, reason: 'bad_archive' })
    // a lying CENTRAL directory changes nothing: sizes come from local headers + actual bytes
    const centralLie = patchZipSize(honest, 'xl/worksheets/sheet1.xml', 'central', 5)
    const parsed = parseXlsxWorkbook(centralLie)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.sheets[0].rows).toHaveLength(2)
  })

  test('row limits REJECT instead of silently truncating', () => {
    const rows: Array<Array<string | number | null>> = [['Товар', 'Сумма']]
    for (let index = 0; index < 20_001; index += 1) rows.push([`P${index}`, 1])
    expect(parseXlsxWorkbook(makeXlsx({ S: sheetXmlOf(rows) }))).toMatchObject({ ok: false, reason: 'sheet_rows_over_limit' })
  })
})

// ── margin engine (incl. the adversarial probe regressions) ─────────────────────────────────────

describe('computeProductMargin', () => {
  test('PROBE: Итого row is excluded once (Cyrillic-safe boundary) and totals stay honest', () => {
    const report = asReport(marginOf({ S: [
      ['Товар', 'Выручка', 'Total cost'],
      ['A', 100, 60],
      ['Итого', 100, 60],
    ] }))
    expect(report.totals.revenueCents).toBe(10_000)
    expect(report.totals.marginCentsComplete).toBe(4_000)
    expect(report.excludedSummaryRows).toHaveLength(1)
    expect(report.totalsComplete).toBe(true)
  })

  test('PROBE: «Сумма себестоимости» maps EXCLUSIVELY to cost, never doubling as revenue', () => {
    const report = asReport(marginOf({ S: [
      ['Товар', 'Сумма себестоимости', 'Цена', 'Количество'],
      ['A', 60, 100, 1],
    ] }))
    const map = report.mapping[0]
    expect(map.columns.total_cost?.column).toBe('B')
    expect(map.columns.revenue).toBeUndefined()
    expect(report.rows[0].revenueCents).toBe(10_000) // derived from price × qty
    expect(report.rows[0].marginCents).toBe(4_000)
    expect(report.totalsComplete).toBe(true)
  })

  test('a bare «Себестоимость» is never guessed: rows become gaps until the mapping is confirmed', () => {
    const report = asReport(marginOf({ S: [
      ['Товар', 'Себестоимость', 'Цена', 'Кол-во'],
      ['A', 60, 100, 1],
    ] }))
    expect(report.mapping[0].costSemantics).toBe('none')
    expect(report.mapping[0].ambiguousCostHeader?.header).toBe('Себестоимость')
    expect(report.costGaps[0]).toMatchObject({ reason: 'cost_semantics_ambiguous' })
    expect(report.rows[0].marginCents).toBeNull()
    expect(report.totalsComplete).toBe(false)
    expect(report.completenessReasons).toContain('cost_gaps:1')
  })

  test('exact decimal money: 1.005 and 2.675 round half-up from the STRING, no float drift', () => {
    const report = asReport(marginOf({ S: [
      ['Товар', 'Выручка', 'Total cost'],
      ['A', '1.005', '0.50'],
      ['B', '2.675', '1.00'],
    ] }))
    expect(report.rows[0].revenueCents).toBe(101)
    expect(report.rows[1].revenueCents).toBe(268)
    expect(formatCents(report.totals.revenueCents)).toBe('3.69')
  })

  test('returns reduce totals and are flagged; missing cost is a gap with a null margin', () => {
    const report = asReport(marginOf({ S: [
      ['Товар', 'Кол-во', 'Выручка', 'Total cost'],
      ['A', 2, 200, 120],
      ['A (возврат)', -1, -100, -60],
      ['B', 1, 50, null],
    ] }))
    expect(report.rows[1].kind).toBe('return')
    expect(report.totals.returnsCount).toBe(1)
    expect(report.totals.revenueCents).toBe(15_000)
    expect(report.rows[2].marginCents).toBeNull()
    expect(report.costGaps).toContainEqual(expect.objectContaining({ name: 'B', reason: 'cost_missing' }))
    expect(report.totalsComplete).toBe(false)
  })

  test('revenue↔price×qty mismatch and skipped sheets each name a completeness reason', () => {
    const report = asReport(marginOf({
      S: [
        ['Товар', 'Кол-во', 'Цена', 'Выручка', 'Total cost'],
        ['A', 2, 100, 150, 80], // 2×100 ≠ 150
      ],
      Unknown: [['непонятная', 'шапка'], ['x', 'y']],
    }))
    expect(report.rows[0].issues).toContain('revenue_mismatch_with_price_qty')
    expect(report.skippedSheets).toHaveLength(1)
    expect(report.totalsComplete).toBe(false)
    expect(report.completenessReasons.join(' ')).toMatch(/rows_with_issues:1/)
    expect(report.completenessReasons.join(' ')).toMatch(/skipped_sheets:1/)
  })

  test('totals overflow rejects the report instead of returning wrapped numbers', () => {
    const rows: Array<Array<string | number | null>> = [['Товар', 'Выручка', 'Total cost']]
    for (let index = 0; index < 20; index += 1) rows.push([`P${index}`, '9999999999999.99', '1'])
    const result = marginOf({ S: rows })
    expect(result).toMatchObject({ ok: false, reason: 'amount_overflow' })
  })

  test('products aggregate across sheets with rankings, covered margin and provenance drilldown', () => {
    const report = asReport(marginOf({
      Sheet1: [
        ['Товар', 'Кол-во', 'Выручка', 'Total cost'],
        ['Плов', 2, 200, 100],
        ['Самса', 5, 100, 80],
      ],
      Sheet2: [
        ['Товар', 'Кол-во', 'Выручка', 'Total cost'],
        ['Плов', 3, 300, 150],
        ['Самса', 1, 20, null], // cost gap → Самса is only PARTIALLY covered
      ],
    }))
    expect(report.products.map((product) => product.name)).toEqual(['Плов', 'Самса'])
    const plov = report.products[0]
    expect(plov).toMatchObject({ qty: 5, revenueCents: 50_000, coveredMarginCents: 25_000, complete: true, rowsCount: 2 })
    expect(plov.provenance).toEqual([
      { sheet: 'Sheet1', rowIndex: 2 }, { sheet: 'Sheet2', rowIndex: 2 },
    ])
    const samsa = report.products[1]
    expect(samsa).toMatchObject({ complete: false, rowsComplete: 1, coveredMarginCents: 2_000, revenueCents: 12_000 })
  })
})

  test('currency column: match passes, mismatch and mixed reject — USD is never labeled UZS', () => {
    const withCurrency = (tokens: string[]) => marginOf({ S: [
      ['Товар', 'Выручка', 'Total cost', 'Валюта'],
      ...tokens.map((token, index): Array<string | number | null> => [`P${index}`, 100, 60, token]),
    ] })
    const matched = withCurrency(['сум', 'UZS'])
    expect(matched.ok).toBe(true) // сум и UZS — одна валюта, совпадает с выбранной UZS
    expect(withCurrency(['USD', 'USD'])).toMatchObject({ ok: false, reason: 'currency_mismatch', detail: expect.stringContaining('USD') })
    expect(withCurrency(['USD', 'сум'])).toMatchObject({ ok: false, reason: 'mixed_currency' })
  })

  test('no declared currency: adopt the file’s single currency, or ASK — never guess', () => {
    const adopted = marginOf({ S: [
      ['Товар', 'Выручка', 'Total cost', 'Валюта'],
      ['A', 100, 60, 'USD'],
    ] }, null)
    expect(adopted.ok).toBe(true)
    if (adopted.ok) expect(adopted.currency).toBe('USD') // the file said USD — adopted, not relabeled
    const silent = marginOf({ S: [
      ['Товар', 'Выручка', 'Total cost'],
      ['A', 100, 60],
    ] }, null)
    expect(silent).toMatchObject({ ok: false, reason: 'needs_currency' })
  })

  test('declared currency outside the allowlist rejects — even when the file has no currency column', () => {
    // report.currency is interpolated into server storage paths: traversal shapes and
    // unsupported codes must die in the engine, not be discovered in a path downstream
    const sheet = { S: [
      ['Товар', 'Выручка', 'Total cost'],
      ['A', 100, 60],
    ] as Array<Array<string | number | null>> }
    expect(marginOf(sheet, '../../evil')).toMatchObject({ ok: false, reason: 'invalid_currency' })
    expect(marginOf(sheet, 'UZS/../x')).toMatchObject({ ok: false, reason: 'invalid_currency' })
    expect(marginOf(sheet, 'GBP')).toMatchObject({ ok: false, reason: 'invalid_currency', detail: 'GBP' })
    expect(marginOf(sheet, 'uzs').ok).toBe(true) // case folds; the allowlist is about identity, not casing
  })

  test('grouping preserves punctuation, prefers SKU over name, flags issue-tainted aggregates', () => {
    const punctuated = asReport(marginOf({ S: [
      ['Товар', 'Выручка', 'Total cost'],
      ['A.1', 100, 50],
      ['A:1', 100, 50],
      ['A 1', 100, 50],
    ] }))
    expect(punctuated.products).toHaveLength(3) // A.1 / A:1 / A 1 are different goods

    const bySku = asReport(marginOf({ S: [
      ['Артикул', 'Товар', 'Выручка', 'Total cost'],
      ['X-77', 'Товар А', 100, 50],
      ['X-77', 'Товар А (упаковка)', 200, 100],
    ] }))
    expect(bySku.products).toHaveLength(1)
    expect(bySku.products[0]).toMatchObject({ sku: 'X-77', rowsCount: 2, revenueCents: 30_000 })

    const tainted = asReport(marginOf({ S: [
      ['Товар', 'Кол-во', 'Цена', 'Выручка', 'Total cost'],
      ['A', 2, 100, 150, 80], // mismatch issue
    ] }))
    expect(tainted.products[0].hasRowIssues).toBe(true)
    expect(tainted.products[0].complete).toBe(false) // an issue-tainted aggregate never claims complete
  })

// ── upload pipeline (the panel's exact waits) ───────────────────────────────────────────────────

describe('runMarginPipeline', async () => {
  const { runMarginPipeline } = await import('../src/lib/marginUpload')
  const goodBytes = makeXlsx({ S: sheetXmlOf([['Товар', 'Выручка', 'Total cost'], ['A', 100, 60]]) })
  const buffer = goodBytes.buffer.slice(goodBytes.byteOffset, goodBytes.byteOffset + goodBytes.byteLength) as ArrayBuffer
  const okDeps = {
    readBuffer: async () => buffer,
    hash: async () => 'deadbeef',
    parse: async (bytes: ArrayBuffer) => parseXlsxWorkbook(bytes),
  }

  test('the happy path computes a report with the hash carried into the meta', async () => {
    const result = await runMarginPipeline(okDeps, { currency: 'UZS', fileName: 'a.xlsx' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.report.meta.fileSha256).toBe('deadbeef')
  })

  test('a STALLED read resolves to a timeout within the deadline and never starts later phases', async () => {
    let parseCalls = 0
    const started = Date.now()
    const result = await runMarginPipeline({
      readBuffer: () => new Promise<ArrayBuffer>(() => {}),
      hash: okDeps.hash,
      parse: async (bytes) => { parseCalls += 1; return parseXlsxWorkbook(bytes) },
    }, { currency: 'UZS', fileName: 'a.xlsx', deadlineMs: 30 })
    expect(result).toEqual({ ok: false, reason: 'parse_timeout' })
    expect(Date.now() - started).toBeLessThan(2_000)
    await new Promise((resolve) => setTimeout(resolve, 60)) // give a late continuation every chance
    expect(parseCalls).toBe(0)
  })

  test('a STALLED hash resolves to a timeout — the worker is never started', async () => {
    let parseCalls = 0
    const result = await runMarginPipeline({
      readBuffer: okDeps.readBuffer,
      hash: () => new Promise<string>(() => {}),
      parse: async (bytes) => { parseCalls += 1; return parseXlsxWorkbook(bytes) },
    }, { currency: 'UZS', fileName: 'a.xlsx', deadlineMs: 30 })
    expect(result).toEqual({ ok: false, reason: 'parse_timeout' })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(parseCalls).toBe(0)
  })

  test('an elapsed budget is detected by the CLOCK, not only the timer flag', async () => {
    let hashCalls = 0
    const result = await runMarginPipeline({
      // busy-loops past the deadline and resolves in the same microtask turn — the timer
      // macrotask has not fired yet, so only the clock check can catch this
      readBuffer: async () => { const end = Date.now() + 30; while (Date.now() < end) { /* spin */ } return buffer },
      hash: async () => { hashCalls += 1; return 'x' },
      parse: async (bytes) => parseXlsxWorkbook(bytes),
    }, { currency: 'UZS', fileName: 'a.xlsx', deadlineMs: 5 })
    expect(result).toEqual({ ok: false, reason: 'parse_timeout' })
    expect(hashCalls).toBe(0)
  })

  test('recovery: after a timed-out run, a fresh run with healthy deps succeeds', async () => {
    await runMarginPipeline({ ...okDeps, readBuffer: () => new Promise<ArrayBuffer>(() => {}) }, { currency: 'UZS', fileName: 'a.xlsx', deadlineMs: 30 })
    const recovered = await runMarginPipeline(okDeps, { currency: 'UZS', fileName: 'a.xlsx' })
    expect(recovered.ok).toBe(true)
  })

  test('a LATE read completion after the deadline cannot resurrect the pipeline', async () => {
    let parseCalls = 0
    const slowRead = new Promise<ArrayBuffer>((resolve) => setTimeout(() => resolve(buffer), 120))
    const result = await runMarginPipeline({
      readBuffer: () => slowRead,
      hash: okDeps.hash,
      parse: async (bytes) => { parseCalls += 1; return parseXlsxWorkbook(bytes) },
    }, { currency: 'UZS', fileName: 'a.xlsx', deadlineMs: 30 })
    expect(result).toEqual({ ok: false, reason: 'parse_timeout' })
    await new Promise((resolve) => setTimeout(resolve, 200)) // the read resolves — nothing may follow
    expect(parseCalls).toBe(0)
  })
})

// ── exports ─────────────────────────────────────────────────────────────────────────────────────

describe('margin report exports', () => {
  const report = asReport(marginOf({ S: [
    ['Товар', 'Кол-во', 'Выручка', 'Total cost'],
    ['=cmd()|hack', 2, 200, 120],
    ['Возврат товара', -1, -100, -60],
    ['Без себестоимости', 1, 50, null],
  ] }))

  test('CSV: strings are injection-guarded, validated numerics (incl. negative returns) are not', () => {
    const csv = marginReportToCsv(report)
    expect(csv).toContain('"\'=cmd()|hack"') // hostile name neutralized
    expect(csv).toMatch(/,-1,-100(\.00)?,-60(\.00)?,/) // return numbers stay numeric for sums
    expect(csv).toContain('MAPPING')
    expect(csv).toContain('total_cost')
    expect(csv).toContain('PRODUCTS')
    expect(csv).toContain('cost_gaps:1')
  })

  test('XLSX interop via BUNDLED PYTHON openpyxl when available (independent reader)', (ctx) => {
    // root verified this interop independently (openpyxl: Margin/Products/Gaps, negative
    // numerics preserved); this check keeps that evidence in the harness where python exists
    const bytes = marginReportToXlsx(report)
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'margin-xlsx-'))
    const file = join(dir, 'report.xlsx')
    writeFileSync(file, bytes)
    // only a MISSING runtime/module skips; a failing READ is a real export regression and fails
    const python = process.env.NEMO_PYTHON || 'python'
    const probe = spawnSync(python, ['-c', 'import openpyxl'], { encoding: 'utf8', timeout: 15_000 })
    if (probe.error || probe.status !== 0) {
      ctx.skip() // no python/openpyxl available — root's independent openpyxl run stands as evidence
      return
    }
    const script = 'import sys, openpyxl\nwb = openpyxl.load_workbook(sys.argv[1])\nprint("|".join(wb.sheetnames))\nvals=[c.value for row in wb["Margin"].iter_rows() for c in row if isinstance(c.value,(int,float))]\nprint("NEG_OK" if any(v==-100 for v in vals) else "NEG_MISSING")'
    const run = spawnSync(python, ['-c', script, file], { encoding: 'utf8', timeout: 30_000 })
    expect(run.error).toBeUndefined()
    expect(run.status, `openpyxl failed to read our export:\n${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('Margin|Products|Gaps')
    expect(run.stdout).toContain('NEG_OK')
  })

  test('the MONTHLY document embeds its frozen snapshot IN the workbook (real builder, roundtrip + openpyxl)', (ctx) => {
    // the frozen provenance must live inside the file itself: a later rename or registry
    // redeclaration cannot change what this document says about itself. This is the REAL
    // production builder over a REAL synthetic workbook, with the EXACT source sha embedded.
    const sourceBytes = makeXlsx({ S: sheetXmlOf([['Товар', 'Выручка', 'Total cost', 'Дата'], ['Widget', 100, 60, '2026-09-12']]) })
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const realSha = createHash('sha256').update(sourceBytes).digest('hex')
    const built = buildProductReportDocument(sourceBytes, {
      file_sha256: realSha, file_name: 'widget.xlsx', period_month: '2026-09',
      uploaded_at: '2026-09-10T10:00:00Z', currency: 'UZS', occurrenceId: 'occ-42', title: 'Сентябрьский отчёт',
      due_date: '2026-09-30',
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const monthlyBytes = built.xlsx
    // OUR parser roundtrip always runs: snapshot strings AND the computed numbers are real cells
    const roundtrip = parseXlsxWorkbook(monthlyBytes)
    expect(roundtrip.ok).toBe(true)
    if (roundtrip.ok) {
      const values = roundtrip.sheets.flatMap((sheet) => sheet.rows.flatMap((row) => Object.values(row.cells).map((cell) => cell.value)))
      for (const needle of ['reporting_period_declared', '2026-09', 'not_verified', realSha, 'occ-42', 'Widget']) {
        expect(values).toContain(needle) // realSha: EXACT equality with the source digest
      }
      // Widget: revenue 100, cost 60 → margin 40 (40%)
      for (const numeric of ['100', '60', '40']) expect(values).toContain(numeric)
    }
    // independent reader where python exists (probe-then-skip, same policy as above)
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const { writeFileSync, mkdtempSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'margin-monthly-'))
    const file = join(dir, 'monthly.xlsx')
    writeFileSync(file, monthlyBytes)
    const python = process.env.NEMO_PYTHON || 'python'
    const probe = spawnSync(python, ['-c', 'import openpyxl'], { encoding: 'utf8', timeout: 15_000 })
    if (probe.error || probe.status !== 0) {
      ctx.skip()
      return
    }
    const script = 'import sys, openpyxl\nwb = openpyxl.load_workbook(sys.argv[1])\nvals=[str(c.value) for row in wb["Margin"].iter_rows() for c in row if c.value is not None]\nnums=[c.value for row in wb["Margin"].iter_rows() for c in row if isinstance(c.value,(int,float))]\nprint("PERIOD_OK" if "reporting_period_declared" in vals and "2026-09" in vals else "PERIOD_MISSING")\nprint("SHA_OK" if sys.argv[2] in vals else "SHA_MISSING")\nprint("COVERAGE_OK" if "not_verified" in vals else "COVERAGE_MISSING")\nprint("NUM_OK" if all(v in nums for v in (100, 60, 40)) else "NUM_MISSING")'
    const run = spawnSync(python, ['-c', script, file, realSha], { encoding: 'utf8', timeout: 30_000 })
    expect(run.error).toBeUndefined()
    expect(run.status, `openpyxl failed to read the monthly export:\n${run.stderr}`).toBe(0)
    expect(run.stdout).toContain('PERIOD_OK')
    expect(run.stdout).toContain('SHA_OK')
    expect(run.stdout).toContain('COVERAGE_OK')
    expect(run.stdout).toContain('NUM_OK')
  })

  test('XLSX round-trips through OUR OWN parser (self-consistency, not independent evidence)', () => {
    const bytes = marginReportToXlsx(report)
    const parsed = parseXlsxWorkbook(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(['Margin', 'Products', 'Gaps'])
    const margin = parsed.sheets[0]
    const flat = margin.rows.map((row) => Object.values(row.cells).map((cell) => cell.value).join('|')).join('\n')
    expect(flat).toContain('=cmd()|hack') // real data, inert in a real workbook cell
    expect(flat).toContain('total_cost') // the mapping ships inside the workbook
    expect(flat).toContain('cost_gaps:1')
    const gaps = parsed.sheets[2]
    expect(gaps.rows.some((row) => Object.values(row.cells).some((cell) => cell.value === 'cost_missing'))).toBe(true)
  })

  test('HTML names every completeness cause and carries products, mapping and issue sections', () => {
    const html = marginReportToHtml(report)
    expect(html).toContain('Итоги НЕПОЛНЫЕ')
    expect(html).toContain('cost_gaps:1')
    expect(html).toContain('Топ товаров по марже')
    expect(html).toContain('Сопоставление колонок')
    expect(html).toContain('Пропуски себестоимости')
    expect(html).toContain('=cmd()|hack') // escaped, displayed as data
    expect(html).not.toContain('<script')
  })
})
