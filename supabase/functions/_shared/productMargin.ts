// Deterministic product-margin computation over a parsed XLSX workbook. No LLM, no I/O.
//
// Semantics contract (finance-stage review conditions + adversarial probe fixes):
//   • header mapping is EXCLUSIVE and most-specific: one field per column, the longest exact
//     synonym wins, so «Сумма себестоимости» can never feed revenue and cost at once;
//   • summary rows (Итого/Всего/Total/Jami…) are recognized with Unicode-aware boundaries
//     (never \b, which fails on Cyrillic), excluded ONCE and listed;
//   • a bare cost label («себестоимость»/«cost»/«tannarx») is NOT guessed into unit-vs-total
//     from the sheet shape — it is reported as ambiguous and every row becomes a cost gap until
//     a human confirms the mapping;
//   • money is parsed from the DECIMAL STRING into integer cents (half-up on the third digit —
//     '1.005' is exactly 1.01, no float drift) with safe-integer bounds, and unit×qty products
//     go through BigInt;
//   • totalsComplete is strict: any cost gap, missing revenue, skipped sheet, parse issue or
//     row-level issue (including a revenue↔price×qty mismatch) makes the totals PARTIAL.
// This report is PRODUCT MARGIN — distinct from the cash-flow analysis; nothing here feeds or
// changes finance-analyze-cashflow.
import { type XlsxParseIssue, type XlsxSheet } from './xlsxIngest.ts'

export interface MarginRow {
  sheet: string
  rowIndex: number
  name: string
  sku: string | null
  qty: number | null
  revenueCents: number | null
  costCents: number | null
  marginCents: number | null
  marginPct: number | null
  kind: 'normal' | 'return'
  issues: string[]
}
type Field = 'name' | 'sku' | 'qty' | 'unit_price' | 'revenue' | 'unit_cost' | 'total_cost'
export interface SheetMapping {
  sheet: string
  headerRowIndex: number
  columns: Partial<Record<Field, { column: string; header: string }>>
  costSemantics: 'unit' | 'total' | 'none'
  /** A bare cost header whose unit-vs-total meaning is unconfirmed — rows become cost gaps. */
  ambiguousCostHeader?: { column: string; header: string }
  /** The file's own currency column, when present — validated against the declared currency. */
  currencyColumn?: { column: string; header: string }
}
export interface MarginReport {
  ok: true
  currency: string
  meta: { fileName: string; fileSha256: string; generatedAt: string }
  mapping: SheetMapping[]
  rows: MarginRow[]
  costGaps: Array<{ sheet: string; rowIndex: number; name: string; reason: string }>
  excludedSummaryRows: Array<{ sheet: string; rowIndex: number; name: string }>
  skippedSheets: Array<{ sheet: string; reason: string }>
  parseIssues: XlsxParseIssue[]
  /** Per-PRODUCT aggregation across all sheets, ranked by covered margin (desc). */
  products: ProductAggregate[]
  totals: {
    rowsTotal: number
    rowsComplete: number
    returnsCount: number
    revenueCents: number
    costCentsComplete: number
    marginCentsComplete: number
    marginPctComplete: number | null
    returnsRevenueCents: number
  }
  totalsComplete: boolean
  /** Every concrete reason the totals are partial — exports must show causes, not just a flag. */
  completenessReasons: string[]
}
export interface ProductAggregate {
  /** Display name = first occurrence; grouped by SKU when present, else the trimmed name. */
  name: string
  sku: string | null
  rowsCount: number
  rowsComplete: number
  /** True when any contributing row carried an issue — the aggregate is then partial. */
  hasRowIssues: boolean
  /** Summed qty; null when ANY contributing row lacked a parseable qty. */
  qty: number | null
  revenueCents: number
  /** Cost/margin summed over the rows that HAD cost — "covered", never extrapolated. */
  coveredRevenueCents: number
  coveredCostCents: number
  coveredMarginCents: number
  coveredMarginPct: number | null
  complete: boolean
  provenance: Array<{ sheet: string; rowIndex: number }>
}
export type MarginResult = MarginReport | {
  ok: false
  reason: 'no_recognized_sheets' | 'amount_overflow' | 'mixed_currency' | 'currency_mismatch' | 'needs_currency' | 'invalid_currency'
  detail?: string
}

const SYNONYMS: Record<Field, string[]> = {
  name: ['наименование', 'название', 'товар', 'номенклатура', 'продукт', 'product', 'name', 'item', 'mahsulot', 'nomi', 'tovar'],
  sku: ['артикул', 'sku', 'код товара', 'artikul', 'item code', 'штрихкод', 'barcode', 'shtrix-kod'],
  qty: ['кол-во', 'колво', 'количество', 'кол', 'qty', 'quantity', 'soni', 'miqdor', 'miqdori', 'шт'],
  unit_price: ['цена', 'цена за ед', 'цена за единицу', 'цена продажи', 'price', 'unit price', 'narx', 'narxi', 'sotish narxi'],
  revenue: ['сумма', 'выручка', 'сумма продажи', 'стоимость', 'revenue', 'amount', 'summa', 'tushum'],
  unit_cost: ['себестоимость за ед', 'себестоимость ед', 'себестоимость за единицу', 'закупочная цена', 'цена закупа', 'закуп цена', 'unit cost', 'tannarx (dona)', 'dona tannarx'],
  total_cost: ['себестоимость сумма', 'сумма себестоимости', 'затраты', 'total cost', 'закуп сумма', 'xarajat'],
}
// bare cost labels whose meaning cannot be assumed — surfaced for explicit confirmation
const AMBIGUOUS_COST = ['себестоимость', 'cost', 'tannarx', 'закуп']
// a currency column, when the file has one, must AGREE with the user's declared currency —
// USD data must never be silently labeled UZS in the report
const CURRENCY_HEADERS = ['валюта', 'currency', 'valyuta', 'вал']
const CURRENCY_ALIASES: Record<string, string> = {
  UZS: 'UZS', 'СУМ': 'UZS', 'SOM': 'UZS', "SO'M": 'UZS', 'SO‘M': 'UZS', 'СЎМ': 'UZS',
  USD: 'USD', $: 'USD', 'ДОЛЛ': 'USD',
  RUB: 'RUB', 'РУБ': 'RUB', '₽': 'RUB',
  EUR: 'EUR', '€': 'EUR',
}
// The only codes the engine will ever put on a report. A declared currency outside this set is
// rejected up front: an unsupported code must not label financial totals, and report.currency is
// interpolated into storage paths downstream — arbitrary caller strings must never reach it.
export const SUPPORTED_CURRENCIES = Object.freeze([...new Set(Object.values(CURRENCY_ALIASES))])
// Unicode-aware word boundary: \b does not work for Cyrillic
const SUMMARY_RE = /^(итого|всего|итог|total|jami|umumiy|жами)(?![\p{L}\p{N}])/iu

// header matching may fold punctuation («Кол-во.» ≈ «кол-во»)…
const normalize = (value: string) => value.toLowerCase().replace(/[\s.:]+/g, ' ').trim()
// …but PRODUCT grouping must not: «A.1», «A:1» and «A 1» are different goods. Only case and
// whitespace fold; an explicit SKU, when the sheet has one, outranks the name entirely.
const productKey = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim()
const MAX_ABS_QTY_MILLI = 1_000_000_000_000 // 1e9 units — beyond this qty is reported unknown

const MAX_ABS_CENTS = 1_000_000_000_000_000 // 1e15 — sums stay far inside 2^53

/** Exact decimal-string → scaled integer (half-up on the digit after `scale`). */
function parseScaled(value: string, scale: number): number | null {
  const cleaned = value.replace(/[\s  ]/g, '').replace(',', '.')
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(cleaned)
  if (!match) return null
  const sign = match[1] === '-' ? -1n : 1n
  const frac = (match[3] ?? '').padEnd(scale + 1, '0')
  const scaledStr = match[2] + frac.slice(0, scale)
  const roundDigit = Number(frac[scale] ?? '0')
  let scaled: bigint
  try { scaled = BigInt(scaledStr) } catch { return null }
  if (roundDigit >= 5) scaled += 1n
  scaled *= sign
  const result = Number(scaled)
  if (!Number.isSafeInteger(result) || Math.abs(result) > MAX_ABS_CENTS) return null
  return result
}
const parseCents = (value: string) => parseScaled(value, 2)
const parseQtyMilli = (value: string) => parseScaled(value, 3)

/** unitCents × qtyMilli / 1000, exact via BigInt, half-up, bounds-checked. */
function mulUnitByQty(unitCents: number, qtyMilli: number): number | null {
  const product = BigInt(unitCents) * BigInt(qtyMilli)
  const sign = product < 0n ? -1n : 1n
  const abs = product < 0n ? -product : product
  const cents = Number(sign * ((abs + 500n) / 1000n))
  return Number.isSafeInteger(cents) && Math.abs(cents) <= MAX_ABS_CENTS ? cents : null
}

interface HeaderCandidate { field: Field | 'ambiguous_cost'; score: number }

function bestCandidate(header: string): HeaderCandidate | null {
  let best: HeaderCandidate | null = null
  const consider = (field: HeaderCandidate['field'], label: string, exactOnly: boolean) => {
    let score = 0
    if (header === label) score = 1_000 + label.length
    else if (!exactOnly && header.startsWith(`${label} `)) score = label.length
    if (score > 0 && (!best || score > best.score)) best = { field, score }
  }
  for (const field of Object.keys(SYNONYMS) as Field[]) {
    for (const label of SYNONYMS[field]) consider(field, label, false)
  }
  for (const label of AMBIGUOUS_COST) consider('ambiguous_cost', label, true)
  return best
}

export function detectMarginHeader(sheet: XlsxSheet): SheetMapping | null {
  for (const row of sheet.rows.slice(0, 10)) {
    const columns: SheetMapping['columns'] = {}
    let ambiguous: SheetMapping['ambiguousCostHeader']
    // exclusive assignment: each COLUMN contributes its single best field, each FIELD takes the
    // first column that claimed it — one column can never serve two fields
    let currencyColumn: SheetMapping['currencyColumn']
    for (const [column, cell] of Object.entries(row.cells)) {
      const header = normalize(cell.value)
      if (!header) continue
      if (!currencyColumn && CURRENCY_HEADERS.includes(header)) { currencyColumn = { column, header: cell.value }; continue }
      const candidate = bestCandidate(header)
      if (!candidate) continue
      if (candidate.field === 'ambiguous_cost') {
        if (!ambiguous) ambiguous = { column, header: cell.value }
      } else if (!columns[candidate.field]) {
        columns[candidate.field] = { column, header: cell.value }
      }
    }
    const hasRevenueShape = Boolean(columns.revenue) || (Boolean(columns.unit_price) && Boolean(columns.qty))
    if (!columns.name || !hasRevenueShape) continue
    const costSemantics: SheetMapping['costSemantics'] = columns.unit_cost ? 'unit' : columns.total_cost ? 'total' : 'none'
    return { sheet: sheet.name, headerRowIndex: row.rowIndex, columns, costSemantics, ambiguousCostHeader: ambiguous, currencyColumn }
  }
  return null
}

/** Shared row classification for the engine and upstream date selection. */
export function marginRowRole(row: XlsxSheet['rows'][number], map: SheetMapping): 'data' | 'summary' | 'blank' {
  const value = (field: Field) => {
    const column = map.columns[field]?.column
    const cell = column ? row.cells[column] : undefined
    return cell && cell.kind !== 'error' ? cell.value : null
  }
  const name = (value('name') ?? '').trim()
  const anyNumeric = (['qty', 'unit_price', 'revenue', 'unit_cost', 'total_cost'] as Field[])
    .some((field) => { const raw = value(field); return raw !== null && parseCents(raw) !== null })
  if (!name && !anyNumeric) return 'blank'
  return SUMMARY_RE.test(name) || (!name && anyNumeric) ? 'summary' : 'data'
}

export function computeProductMargin(
  input: { sheets: XlsxSheet[]; issues: XlsxParseIssue[] },
  // currency: an explicit code labels the report (and must match the file's own currency column
  // if one exists); null/undefined means "adopt the file's single declared currency" — and when
  // the file declares nothing, the result is needs_currency: the caller must ASK, never guess.
  options: { currency?: string | null; fileName?: string; fileSha256?: string; now?: () => Date } = {},
): MarginResult {
  const now = options.now ?? (() => new Date())
  const mapping: SheetMapping[] = []
  const skippedSheets: MarginReport['skippedSheets'] = []
  const rows: MarginRow[] = []
  const costGaps: MarginReport['costGaps'] = []
  const excludedSummaryRows: MarginReport['excludedSummaryRows'] = []
  const currencyTokens = new Set<string>()

  for (const sheet of input.sheets) {
    const map = detectMarginHeader(sheet)
    if (!map) { skippedSheets.push({ sheet: sheet.name, reason: 'no_recognized_header' }); continue }
    mapping.push(map)
    const cellText = (row: XlsxSheet['rows'][number], field: Field): string | null => {
      const column = map.columns[field]?.column
      if (!column) return null
      const cell = row.cells[column]
      return cell && cell.kind !== 'error' ? cell.value : null
    }
    for (const row of sheet.rows) {
      if (row.rowIndex <= map.headerRowIndex) continue
      const name = (cellText(row, 'name') ?? '').trim()
      const sku = (cellText(row, 'sku') ?? '').trim() || null
      const qtyRaw = cellText(row, 'qty')
      const unitPriceRaw = cellText(row, 'unit_price')
      const revenueRaw = cellText(row, 'revenue')
      const unitCostRaw = cellText(row, 'unit_cost')
      const totalCostRaw = cellText(row, 'total_cost')
      const rowRole = marginRowRole(row, map)
      if (rowRole === 'blank') continue // blank spacer row
      // summary rows are recognized and EXCLUDED — a grand total inside the data would be
      // counted twice by any honest sum
      if (rowRole === 'summary') {
        excludedSummaryRows.push({ sheet: sheet.name, rowIndex: row.rowIndex, name: name || '(без названия)' })
        continue
      }

      if (map.currencyColumn) {
        const token = (row.cells[map.currencyColumn.column]?.value ?? '').trim().toUpperCase()
        if (token) currencyTokens.add(token)
      }

      const issues: string[] = []
      const qtyMilli = qtyRaw === null ? null : parseQtyMilli(qtyRaw)
      if (qtyRaw !== null && qtyMilli === null) issues.push('qty_unparseable')
      const unitPriceCents = unitPriceRaw === null ? null : parseCents(unitPriceRaw)
      if (unitPriceRaw !== null && unitPriceCents === null) issues.push('unit_price_unparseable')
      const revenueExplicit = revenueRaw === null ? null : parseCents(revenueRaw)
      if (revenueRaw !== null && revenueExplicit === null) issues.push('revenue_unparseable')

      let revenueCents: number | null = null
      if (revenueExplicit !== null) {
        revenueCents = revenueExplicit
        if (unitPriceCents !== null && qtyMilli !== null) {
          const derived = mulUnitByQty(unitPriceCents, qtyMilli)
          if (derived !== null && Math.abs(derived - revenueCents) > 1) issues.push('revenue_mismatch_with_price_qty')
        }
      } else if (unitPriceCents !== null && qtyMilli !== null) {
        revenueCents = mulUnitByQty(unitPriceCents, qtyMilli)
        if (revenueCents === null) issues.push('revenue_out_of_bounds')
      } else {
        issues.push('revenue_missing')
      }

      let costCents: number | null = null
      let gapReason: string | null = null
      const unitCostCents = unitCostRaw === null ? null : parseCents(unitCostRaw)
      const totalCostCents = totalCostRaw === null ? null : parseCents(totalCostRaw)
      if (map.costSemantics === 'unit') {
        if (unitCostCents === null) gapReason = unitCostRaw === null ? 'cost_missing' : 'cost_unparseable'
        else if (qtyMilli === null) gapReason = 'unit_cost_needs_qty'
        else {
          costCents = mulUnitByQty(unitCostCents, qtyMilli)
          if (costCents === null) gapReason = 'cost_out_of_bounds'
        }
      } else if (map.costSemantics === 'total') {
        if (totalCostCents === null) gapReason = totalCostRaw === null ? 'cost_missing' : 'cost_unparseable'
        else costCents = totalCostCents
      } else if (map.ambiguousCostHeader) {
        // a bare cost label is never guessed — it stays a gap until the mapping is confirmed
        gapReason = 'cost_semantics_ambiguous'
      } else {
        gapReason = 'no_cost_column'
      }
      if (gapReason) costGaps.push({ sheet: sheet.name, rowIndex: row.rowIndex, name, reason: gapReason })

      const marginCents = revenueCents !== null && costCents !== null ? revenueCents - costCents : null
      rows.push({
        sheet: sheet.name,
        rowIndex: row.rowIndex,
        name,
        sku,
        qty: qtyMilli === null ? null : qtyMilli / 1000,
        revenueCents,
        costCents,
        marginCents,
        marginPct: marginCents !== null && revenueCents !== null && revenueCents !== 0
          ? Math.round((marginCents / revenueCents) * 10_000) / 100
          : null,
        kind: (qtyMilli !== null && qtyMilli < 0) || (revenueCents !== null && revenueCents < 0) ? 'return' : 'normal',
        issues,
      })
    }
  }
  if (!mapping.length) return { ok: false, reason: 'no_recognized_sheets' }

  // currency safety: a file that declares its currency must AGREE with the user's declaration —
  // mixed currencies, or USD data under a UZS label, reject instead of producing a wrong report
  const declaredCurrency = options.currency === undefined || options.currency === null ? null : options.currency.toUpperCase()
  if (declaredCurrency !== null && !SUPPORTED_CURRENCIES.includes(declaredCurrency)) {
    return { ok: false, reason: 'invalid_currency', detail: declaredCurrency.slice(0, 40) }
  }
  let effectiveCurrency = declaredCurrency
  if (currencyTokens.size) {
    const mapped = new Set([...currencyTokens].map((token) => CURRENCY_ALIASES[token] ?? `?${token}`))
    if (mapped.size > 1) return { ok: false, reason: 'mixed_currency', detail: [...currencyTokens].join(', ') }
    const [detected] = mapped
    if (detected.startsWith('?')) {
      // an unrecognized currency token can neither be adopted nor silently relabeled
      return declaredCurrency === null
        ? { ok: false, reason: 'needs_currency', detail: [...currencyTokens].join(', ') }
        : { ok: false, reason: 'currency_mismatch', detail: [...currencyTokens].join(', ') }
    }
    if (declaredCurrency === null) effectiveCurrency = detected
    else if (detected !== declaredCurrency) {
      return { ok: false, reason: 'currency_mismatch', detail: [...currencyTokens].join(', ') }
    }
  }
  if (effectiveCurrency === null) return { ok: false, reason: 'needs_currency' }

  // totals accumulate in BigInt: 1e15-cent rows × 60k rows overflow 2^53 in plain Number math.
  // Conversion back is CHECKED — an overflowing total rejects the report instead of lying.
  let revenueBig = 0n
  let costCompleteBig = 0n
  let marginCompleteBig = 0n
  let completeRevenueBig = 0n
  let returnsRevenueBig = 0n
  let rowsComplete = 0
  let returnsCount = 0
  interface Agg {
    name: string
    sku: string | null
    rowsCount: number
    rowsComplete: number
    hasRowIssues: boolean
    qtyMilli: number
    qtyKnown: boolean
    revenue: bigint
    coveredRevenue: bigint
    coveredCost: bigint
    coveredMargin: bigint
    provenance: Array<{ sheet: string; rowIndex: number }>
  }
  const byProduct = new Map<string, Agg>()
  for (const row of rows) {
    if (row.revenueCents !== null) revenueBig += BigInt(row.revenueCents)
    if (row.kind === 'return') { returnsCount += 1; returnsRevenueBig += BigInt(row.revenueCents ?? 0) }
    const complete = row.marginCents !== null && row.revenueCents !== null && row.costCents !== null
    if (complete) {
      rowsComplete += 1
      costCompleteBig += BigInt(row.costCents!)
      marginCompleteBig += BigInt(row.marginCents!)
      completeRevenueBig += BigInt(row.revenueCents!)
    }
    const key = row.sku ? `sku:${row.sku.toLowerCase()}` : (productKey(row.name) ? `name:${productKey(row.name)}` : '')
    if (key) {
      const agg = byProduct.get(key) ?? {
        name: row.name, sku: row.sku, rowsCount: 0, rowsComplete: 0, hasRowIssues: false,
        qtyMilli: 0, qtyKnown: true,
        revenue: 0n, coveredRevenue: 0n, coveredCost: 0n, coveredMargin: 0n, provenance: [],
      }
      agg.rowsCount += 1
      if (row.issues.length) agg.hasRowIssues = true
      if (row.qty === null) agg.qtyKnown = false
      else {
        agg.qtyMilli += Math.round(row.qty * 1000)
        if (!Number.isSafeInteger(agg.qtyMilli) || Math.abs(agg.qtyMilli) > MAX_ABS_QTY_MILLI) agg.qtyKnown = false
      }
      if (row.revenueCents !== null) agg.revenue += BigInt(row.revenueCents)
      if (complete) {
        agg.rowsComplete += 1
        agg.coveredRevenue += BigInt(row.revenueCents!)
        agg.coveredCost += BigInt(row.costCents!)
        agg.coveredMargin += BigInt(row.marginCents!)
      }
      agg.provenance.push({ sheet: row.sheet, rowIndex: row.rowIndex })
      byProduct.set(key, agg)
    }
  }
  const toSafeCents = (value: bigint): number | null => {
    const converted = Number(value)
    return Number.isSafeInteger(converted) && Math.abs(converted) <= MAX_ABS_CENTS ? converted : null
  }
  const totalCandidates = [revenueBig, costCompleteBig, marginCompleteBig, completeRevenueBig, returnsRevenueBig]
  if (totalCandidates.some((value) => toSafeCents(value) === null)) return { ok: false, reason: 'amount_overflow' }
  const products: ProductAggregate[] = []
  for (const agg of byProduct.values()) {
    const values = [agg.revenue, agg.coveredRevenue, agg.coveredCost, agg.coveredMargin].map(toSafeCents)
    if (values.some((value) => value === null)) return { ok: false, reason: 'amount_overflow' }
    const [revenue, coveredRevenue, coveredCost, coveredMargin] = values as number[]
    products.push({
      name: agg.name,
      sku: agg.sku,
      rowsCount: agg.rowsCount,
      rowsComplete: agg.rowsComplete,
      hasRowIssues: agg.hasRowIssues,
      qty: agg.qtyKnown ? agg.qtyMilli / 1000 : null,
      revenueCents: revenue,
      coveredRevenueCents: coveredRevenue,
      coveredCostCents: coveredCost,
      coveredMarginCents: coveredMargin,
      coveredMarginPct: coveredRevenue !== 0 ? Math.round((coveredMargin / coveredRevenue) * 10_000) / 100 : null,
      // an aggregate with any gap OR any row-level issue among its rows is PARTIAL
      complete: agg.rowsComplete === agg.rowsCount && !agg.hasRowIssues,
      provenance: agg.provenance,
    })
  }
  products.sort((a, b) => b.coveredMarginCents - a.coveredMarginCents)
  const revenueCents = toSafeCents(revenueBig)!
  const costCentsComplete = toSafeCents(costCompleteBig)!
  const marginCentsComplete = toSafeCents(marginCompleteBig)!
  const completeRevenueCents = toSafeCents(completeRevenueBig)!
  const returnsRevenueCents = toSafeCents(returnsRevenueBig)!
  const completenessReasons: string[] = []
  if (costGaps.length) completenessReasons.push(`cost_gaps:${costGaps.length}`)
  if (skippedSheets.length) completenessReasons.push(`skipped_sheets:${skippedSheets.length}`)
  if (input.issues.length) completenessReasons.push(`parse_issues:${input.issues.length}`)
  const missingRevenue = rows.filter((row) => row.revenueCents === null).length
  if (missingRevenue) completenessReasons.push(`rows_without_revenue:${missingRevenue}`)
  const rowsWithIssues = rows.filter((row) => row.issues.length > 0).length
  if (rowsWithIssues) completenessReasons.push(`rows_with_issues:${rowsWithIssues}`)
  if (!rows.length) completenessReasons.push('no_rows')
  return {
    ok: true,
    currency: effectiveCurrency,
    meta: { fileName: options.fileName ?? '', fileSha256: options.fileSha256 ?? '', generatedAt: now().toISOString() },
    mapping,
    rows,
    costGaps,
    excludedSummaryRows,
    skippedSheets,
    parseIssues: input.issues,
    products,
    totals: {
      rowsTotal: rows.length,
      rowsComplete,
      returnsCount,
      revenueCents,
      costCentsComplete,
      marginCentsComplete,
      marginPctComplete: completeRevenueCents !== 0 ? Math.round((marginCentsComplete / completeRevenueCents) * 10_000) / 100 : null,
      returnsRevenueCents,
    },
    // STRICT completeness with NAMED causes: any gap, missing revenue, skipped sheet, parse
    // issue or row issue (including a revenue↔price×qty mismatch) makes the totals partial
    totalsComplete: completenessReasons.length === 0,
    completenessReasons,
  }
}

export const formatCents = (cents: number): string => (cents / 100).toFixed(2)

/** Bumped on any change to margin semantics — part of the deterministic output/retry key. */
export const MARGIN_ENGINE_VERSION = 1
