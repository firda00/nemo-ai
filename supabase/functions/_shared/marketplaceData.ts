export interface MarketplaceCalculatedRow {
  sku: string
  sales7d: number
  stock: number
  leadTimeDays: number
  inbound: number
  safetyStock: number | null
  dailyVelocity: number
  stockCoverDays: number | null
  baselineTargetUnits: number
  baselineReorderUnits: number
  reorderUnits: number | null
  unitMarginBeforeAdsAndFulfillment: number | null
  classification: 'scale' | 'keep' | 'clear' | 'pause' | 'insufficient_data'
  missing: string[]
}

export type MarketplaceField =
  | 'sku'
  | 'sales7d'
  | 'stock'
  | 'leadTimeDays'
  | 'inbound'
  | 'safetyStock'
  | 'cost'
  | 'price'
  | 'feePercent'

const FIELDS: MarketplaceField[] = [
  'sku', 'sales7d', 'stock', 'leadTimeDays', 'inbound', 'safetyStock', 'cost', 'price', 'feePercent',
]

// Header matching is scored, not exact: a real export says "Продажи за 7 дней", not "sales_7d".
// A score of 100 is a canonical name; anything lower is reported as a loose match so the
// deliverable can name the assumption instead of hiding it. All patterns run against a
// normalized header (lowercase, ё→е, every non-alphanumeric run collapsed to "_").
interface HeaderRule { all: RegExp[]; score: number }

const HEADER_RULES: Record<MarketplaceField, HeaderRule[]> = {
  sku: [
    { all: [/^(sku|артикул|article|product_id|productid|товар_id|код_товара|kod_tovara|номенклатура|barcode|штрихкод)$/], score: 100 },
    { all: [/(^|_)(sku|артикул|article)(_|$)/], score: 70 },
  ],
  sales7d: [
    { all: [/^(sales_7d|sales7d|продажи_7д|продажи7д|продажи_7|заказы_7д|orders_7d)$/], score: 100 },
    { all: [/(продаж|заказ|sales|orders|продано|units_sold|sotuv|buyurtma)/, /(^|_)(7|7д|7d|недел|week|hafta)(_|$)/], score: 85 },
    { all: [/^(продажи|заказы|sales|orders|продано|units_sold|sotuv)$/], score: 55 },
  ],
  stock: [
    { all: [/^(stock|остаток|остатки|on_hand|qty|quantity|qoldiq|наличие)$/], score: 100 },
    { all: [/(остат|склад|stock|qoldiq|наличи)/, /^(?!.*(safety|страхов|резерв|min|max|макс)).*$/], score: 70 },
  ],
  leadTimeDays: [
    { all: [/^(lead_time_days|lead_time|leadtime|срок_поставки_дней|дней_поставки|срок_поставки)$/], score: 100 },
    { all: [/(lead_?time|срок_поставк|поставк|yetkaz)/, /(дн|day|kun|срок)/], score: 75 },
  ],
  inbound: [
    { all: [/^(inbound|confirmed_inbound|в_пути|подтверждено_в_пути)$/], score: 100 },
    { all: [/(inbound|в_пути|в_дороге|ожидается|yolda)/], score: 70 },
  ],
  safetyStock: [
    { all: [/^(safety_stock|страховой_запас|резерв|safety)$/], score: 100 },
    { all: [/(safety|страхов|резерв|min_stock|минимальный_запас)/], score: 75 },
  ],
  cost: [
    { all: [/^(cost|себестоимость|закупочная_цена|закупка|zakup|tannarx|cost_price)$/], score: 100 },
    { all: [/(себестоим|закупочн|закуп_цена|cost_price|purchase_price|tannarx)/], score: 80 },
  ],
  price: [
    { all: [/^(price|цена|selling_price|продажная_цена|цена_продажи|narx)$/], score: 100 },
    { all: [/(цена|price|narx)/, /^(?!.*(закуп|себестоим|cost|tannarx)).*$/], score: 60 },
  ],
  feePercent: [
    { all: [/^(fee_percent|commission_percent|комиссия_процент|комиссия|fee|commission)$/], score: 100 },
    { all: [/(комисси|commission|(^|_)fee(_|$))/], score: 70 },
  ],
}

const DELIMITERS = [',', ';', '\t', '|']
const SEPARATOR_RE = /^[\s|:+-]+$/
const MARKETPLACE_VOCAB =
  /(sku|артикул|продаж|заказ|остат|склад|закуп|себестоим|цена|price|stock|sales|inventory|ассортимент|товар)/i

const normalize = (value: string) =>
  value.trim().toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '')

const number = (value: string | undefined): number | null => {
  if (value == null || !value.trim()) return null
  const parsed = Number(value.trim().replace(/\s/g, '').replace(',', '.').replace('%', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function splitRow(line: string, delimiter: string): string[] {
  const cells = line.split(delimiter).map((cell) => cell.trim())
  // A Markdown table has a leading and trailing pipe; dropping the empty edges keeps
  // header and data rows on the same indexes.
  if (delimiter === '|') {
    while (cells.length && cells[0] === '') cells.shift()
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
  }
  return cells
}

function delimiterOf(line: string): string {
  let best = DELIMITERS[0]
  let bestCount = splitRow(line, best).length
  for (const candidate of DELIMITERS.slice(1)) {
    const count = splitRow(line, candidate).length
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

interface HeaderMap {
  index: Record<MarketplaceField, number>
  header: Partial<Record<MarketplaceField, string>>
  loose: MarketplaceField[]
}

interface CellCandidate {
  field: MarketplaceField
  score: number
  header: string
  after: string
}

const namesAField = (text: string): boolean =>
  text.split(/\s+/).filter(Boolean).some((word) => {
    const normalized = normalize(word)
    return Boolean(normalized) && FIELDS.some((field) =>
      HEADER_RULES[field].some((rule) => rule.all.every((re) => re.test(normalized))))
  })

// In a one-line paste the last header is glued to the first value: "lead_time_days A-1".
// Splitting on that space recovers both. But "Остаток на складе" is ONE header, and splitting
// it would let its first word claim an exact match and outrank the truth — so the split is
// only allowed when the leftover names no field of its own.
function cellCandidates(cell: string): CellCandidate[] {
  const found: CellCandidate[] = []
  const collect = (text: string, after: string) => {
    const normalized = normalize(text)
    if (!normalized) return
    for (const field of FIELDS) {
      for (const rule of HEADER_RULES[field]) {
        if (rule.all.every((re) => re.test(normalized))) {
          found.push({ field, score: rule.score, header: text.trim(), after })
        }
      }
    }
  }
  collect(cell, '')
  const words = cell.split(/\s+/).filter(Boolean)
  if (words.length > 1) {
    const rest = words.slice(1).join(' ')
    if (!namesAField(rest)) collect(words[0], rest)
  }
  return found
}

function mapHeaders(cells: string[]): HeaderMap | null {
  const candidates: Array<{ field: MarketplaceField; col: number; score: number }> = []
  cells.forEach((cell, col) => {
    for (const candidate of cellCandidates(cell)) {
      candidates.push({ field: candidate.field, col, score: candidate.score })
    }
  })
  // Highest-confidence claim wins the column, so "закупочная цена" resolves to cost
  // and only a genuinely different column can still be taken as price.
  candidates.sort((a, b) => b.score - a.score || a.col - b.col)
  const index = {} as Record<MarketplaceField, number>
  for (const field of FIELDS) index[field] = -1
  const header: Partial<Record<MarketplaceField, string>> = {}
  const loose: MarketplaceField[] = []
  const takenColumns = new Set<number>()
  for (const candidate of candidates) {
    if (index[candidate.field] >= 0 || takenColumns.has(candidate.col)) continue
    index[candidate.field] = candidate.col
    header[candidate.field] = cells[candidate.col].trim().slice(0, 60)
    takenColumns.add(candidate.col)
    if (candidate.score < 100) loose.push(candidate.field)
  }
  if (index.sku < 0 || index.sales7d < 0 || index.stock < 0) return null
  return { index, header, loose }
}

const nonEmptyLines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

// "There is data here that we failed to read" must be distinguishable from "this is a
// strategy task with no data at all" — the first one has to warn, the second must stay silent.
// Silence is only ever legitimate for the second case.
function looksTabular(text: string): boolean {
  if (!MARKETPLACE_VOCAB.test(text)) return false
  let rows = 0
  let numericRows = 0
  for (const line of nonEmptyLines(text)) {
    if (!/[,;\t|]/.test(line) || SEPARATOR_RE.test(line)) continue
    const cells = splitRow(line, delimiterOf(line))
    if (cells.length < 3 || cells.some((cell) => cell.length > 40)) continue
    rows++
    if (cells.filter((cell) => number(cell) != null).length >= 2) numericRows++
  }
  if (rows >= 2 && numericRows >= 1) return true
  // A single-line paste has no rows to count — Telegram, chat and plain textarea input all
  // arrive this way. A run of delimited numbers is data whether or not it survived parsing.
  const cells = splitRow(text, delimiterOf(text))
  if (cells.length < 4) return false
  const numeric = cells.filter((cell) => {
    const last = cell.split(/\s+/).filter(Boolean).pop() ?? ''
    return number(cell) != null || number(last) != null
  }).length
  return numeric >= 3
}

// The header run inside a one-line paste: the longest stretch of adjacent cells that each name
// a distinct field and together cover sku + sales + stock. Its width is the column count.
function inlineHeaderRun(cells: string[]) {
  const best = cells.map((cell) => cellCandidates(cell).sort((a, b) => b.score - a.score)[0] ?? null)
  let run: { start: number; end: number } | null = null
  let i = 0
  while (i < best.length) {
    if (!best[i]) { i++; continue }
    const seen = new Set<MarketplaceField>()
    let j = i
    while (j < best.length && best[j] && !seen.has(best[j]!.field)) {
      seen.add(best[j]!.field)
      j++
    }
    if (seen.has('sku') && seen.has('sales7d') && seen.has('stock')) {
      if (!run || j - 1 - i > run.end - run.start) run = { start: i, end: j - 1 }
    }
    i = j
  }
  if (!run) return null
  const matched = best.slice(run.start, run.end + 1) as CellCandidate[]
  return {
    end: run.end,
    fields: matched.map((m) => m.field),
    headers: matched.map((m) => m.header),
    tail: matched[matched.length - 1].after,
  }
}

// Rebuild the rows a one-line paste destroyed: take the column count from the header run and
// cut the remaining values into chunks of that width, keeping the leading chunks that validate.
function recoverInlineTable(text: string): string | null {
  const cells = splitRow(text, delimiterOf(text)).slice(0, 400)
  if (cells.length < 4) return null
  const run = inlineHeaderRun(cells)
  if (!run) return null
  const width = run.fields.length
  const tokens: string[] = []
  if (run.tail) tokens.push(...run.tail.split(/\s+/).filter(Boolean))
  for (const cell of cells.slice(run.end + 1)) tokens.push(...cell.split(/\s+/).filter(Boolean))

  const skuAt = run.fields.indexOf('sku')
  const salesAt = run.fields.indexOf('sales7d')
  const stockAt = run.fields.indexOf('stock')
  const accepted: string[][] = []
  for (let i = 0; i + width <= tokens.length; i += width) {
    const row = tokens.slice(i, i + width)
    // Trailing prose ("…и дай план на неделю") lands in the next chunk and fails here,
    // which ends the table instead of silently inventing a row out of words.
    if (!row[skuAt] || number(row[salesAt]) == null || number(row[stockAt]) == null) break
    accepted.push(row)
  }
  if (!accepted.length) return null
  return [run.headers.join(','), ...accepted.map((row) => row.join(','))].join('\n')
}

export type MarketplaceEvidenceStatus = 'calculated' | 'unparsed' | 'no_table'

export interface MarketplaceEvidence {
  status: MarketplaceEvidenceStatus
  rows: MarketplaceCalculatedRow[]
  mapping: Partial<Record<MarketplaceField, string>>
  looseColumns: MarketplaceField[]
}

export function analyzeMarketplaceText(text: string, maxRows = 500): MarketplaceEvidence {
  const direct = parseTable(text, maxRows)
  if (direct) return direct
  const recovered = recoverInlineTable(text)
  const salvaged = recovered ? parseTable(recovered, maxRows) : null
  if (salvaged) return salvaged
  return { status: looksTabular(text) ? 'unparsed' : 'no_table', rows: [], mapping: {}, looseColumns: [] }
}

function parseTable(text: string, maxRows: number): MarketplaceEvidence | null {
  const lines = nonEmptyLines(text)
  let headerIndex = -1
  let delimiter = ','
  let headers: HeaderMap | null = null
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const candidateDelimiter = delimiterOf(lines[i])
    const mapped = mapHeaders(splitRow(lines[i], candidateDelimiter))
    if (mapped) {
      headerIndex = i
      delimiter = candidateDelimiter
      headers = mapped
      break
    }
  }
  if (!headers || headerIndex < 0) return null

  const indexes = headers.index
  const result: MarketplaceCalculatedRow[] = []
  for (const line of lines.slice(headerIndex + 1)) {
    if (result.length >= maxRows) break
    if (SEPARATOR_RE.test(line)) continue
    const cells = splitRow(line, delimiter)
    const sku = cells[indexes.sku]?.slice(0, 120)
    if (!sku) continue
    const sales7d = number(cells[indexes.sales7d])
    const stock = number(cells[indexes.stock])
    const leadTimeDays = indexes.leadTimeDays >= 0 ? number(cells[indexes.leadTimeDays]) : null
    const inbound = indexes.inbound >= 0 ? number(cells[indexes.inbound]) : 0
    const safetyStock = indexes.safetyStock >= 0 ? number(cells[indexes.safetyStock]) : null
    const cost = indexes.cost >= 0 ? number(cells[indexes.cost]) : null
    const price = indexes.price >= 0 ? number(cells[indexes.price]) : null
    const feePercent = indexes.feePercent >= 0 ? number(cells[indexes.feePercent]) : null
    // A row that carries no numbers at all is prose that happened to sit under the header.
    if (sales7d == null && stock == null && leadTimeDays == null && price == null && cost == null) continue
    const missing: string[] = []
    if (sales7d == null || sales7d < 0) missing.push('sales_7d')
    if (stock == null || stock < 0) missing.push('stock')
    if (leadTimeDays == null || leadTimeDays < 0) missing.push('lead_time_days')

    const safeSales = sales7d != null && sales7d >= 0 ? sales7d : 0
    const safeStock = stock != null && stock >= 0 ? stock : 0
    const safeLeadTime = leadTimeDays != null && leadTimeDays >= 0 ? leadTimeDays : 0
    const safeInbound = inbound != null && inbound >= 0 ? inbound : 0
    const dailyVelocity = safeSales / 7
    const stockCoverDays = dailyVelocity > 0 ? safeStock / dailyVelocity : null
    const baselineTargetUnits = Math.ceil(dailyVelocity * (7 + safeLeadTime))
    const baselineReorderUnits = Math.max(0, baselineTargetUnits - safeStock - safeInbound)
    const reorderUnits = safetyStock == null
      ? null
      : Math.max(0, baselineTargetUnits + Math.max(0, safetyStock) - safeStock - safeInbound)
    const unitMarginBeforeAdsAndFulfillment = cost != null && price != null && feePercent != null
      ? Number((price - cost - price * feePercent / 100).toFixed(2))
      : null
    if (safetyStock == null) missing.push('safety_stock')
    if (unitMarginBeforeAdsAndFulfillment == null) missing.push('complete_unit_economics')

    let classification: MarketplaceCalculatedRow['classification'] = 'keep'
    if (missing.includes('sales_7d') || missing.includes('stock') || missing.includes('lead_time_days')) classification = 'insufficient_data'
    else if (safeSales === 0 && safeStock > 0) classification = 'pause'
    else if (stockCoverDays != null && stockCoverDays > 56) classification = 'clear'
    else if (baselineReorderUnits > 0) classification = 'scale'

    result.push({
      sku,
      sales7d: safeSales,
      stock: safeStock,
      leadTimeDays: safeLeadTime,
      inbound: safeInbound,
      safetyStock,
      dailyVelocity: Number(dailyVelocity.toFixed(4)),
      stockCoverDays: stockCoverDays == null ? null : Number(stockCoverDays.toFixed(1)),
      baselineTargetUnits,
      baselineReorderUnits,
      reorderUnits,
      unitMarginBeforeAdsAndFulfillment,
      classification,
      missing: [...new Set(missing)],
    })
  }

  if (!result.length) return null
  return { status: 'calculated', rows: result, mapping: headers.header, looseColumns: headers.loose }
}

export function calculateMarketplaceRows(text: string, maxRows = 500): MarketplaceCalculatedRow[] {
  return analyzeMarketplaceText(text, maxRows).rows
}

const UNVERIFIED_BLOCK = [
  '=== NUMBERS ARE NOT SERVER-VERIFIED ===',
  'The request carries data, but Nemo could not read it as a table of sku / sales / stock, so NOTHING here was computed deterministically.',
  'Do not present any quantity as purchase-ready: no final purchase quantity, no safety stock, no order value, no money saved.',
  'Write every calculation as "inputs -> formula -> result" and re-check each subtraction against the inputs shown in the same sentence.',
  'State plainly that the numbers are UNVERIFIED, and ask for a re-export with named columns: sku, sales_7d, stock, lead_time_days (optional: safety_stock, cost, price, fee_percent).',
].join('\n')

export function marketplaceEvidenceBlock(text: string): string {
  const evidence = analyzeMarketplaceText(text)
  if (evidence.status === 'no_table') return ''
  if (evidence.status === 'unparsed') return UNVERIFIED_BLOCK
  const mapping = Object.entries(evidence.mapping)
    .map(([field, header]) => `${field}="${header}"`)
    .join('; ')
  return [
    '=== SERVER-CALCULATED MARKETPLACE EVIDENCE ===',
    'These values are deterministic. Copy them exactly; do not recalculate them in prose.',
    `Column mapping (field="source header"): ${mapping}`,
    ...(evidence.looseColumns.length
      ? [`LOOSELY MATCHED COLUMNS — name this assumption in the deliverable and ask the client to confirm: ${evidence.looseColumns.join(', ')}.`]
      : []),
    'Formula: daily_velocity=sales_7d/7; baseline_target=ceil(daily_velocity*(7+lead_time_days)); baseline_reorder=max(0,baseline_target-stock-inbound).',
    'Every quantity you write must equal the matching field here. If your own arithmetic disagrees with reorder_units or baseline_reorder, these values win — never publish a number that contradicts the inputs shown beside it.',
    'If safety_stock is missing, baseline_reorder is a planning baseline only and reorder_units is null: request safety stock before presenting a purchase-ready quantity.',
    'unit_margin excludes advertising, logistics, returns and taxes unless those costs are separately supplied.',
    JSON.stringify(evidence.rows),
  ].join('\n')
}
