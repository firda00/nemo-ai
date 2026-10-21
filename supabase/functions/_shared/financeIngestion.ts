import { z } from 'zod'
import { FinanceTransactionSchema, type FinanceTransaction } from './financeCashFlow.ts'
import { FinanceInstantSchema, FinancePeriodSchema, financeImportDate } from './financeTime.ts'
import { financeAmountMinor } from './financeAmounts.ts'

const SourceIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const RowSchema = z.record(z.unknown())

const SourceBaseSchema = z.object({
  source_id: SourceIdSchema,
  imported_at: FinanceInstantSchema,
  default_currency: z.string().regex(/^[A-Z]{3}$/).default('UZS'),
  amount_scale: z.number().int().min(1).max(1000).default(100),
  default_account_id: SourceIdSchema.optional(),
})

const CsvSourceSchema = SourceBaseSchema.extend({
  format: z.literal('csv'),
  content: z.string().min(1).max(2_000_000),
  delimiter: z.enum([',', ';', '\t']).optional(),
}).strict()

const ExcelJsonSourceSchema = SourceBaseSchema.extend({
  format: z.literal('excel_json'),
  sheets: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    rows: z.array(RowSchema).max(10_000),
  }).strict()).min(1).max(30),
}).strict()

const PdfJsonSourceSchema = SourceBaseSchema.extend({
  format: z.literal('pdf_json'),
  pages: z.array(z.object({
    page: z.number().int().positive(),
    text: z.string().max(100_000).default(''),
    tables: z.array(z.array(RowSchema).max(5_000)).max(50).default([]),
  }).strict()).min(1).max(2_000),
}).strict()

export const FinanceInputSourceSchema = z.discriminatedUnion('format', [
  CsvSourceSchema,
  ExcelJsonSourceSchema,
  PdfJsonSourceSchema,
])

export const FinanceAnalyzeApiInputSchema = z.object({
  workspace_id: z.string().uuid(),
  period: FinancePeriodSchema,
  base_currency: z.string().regex(/^[A-Z]{3}$/),
  opening_balance_minor: z.number().int().safe(),
  transactions: z.array(FinanceTransactionSchema).max(10_000).default([]),
  sources: z.array(FinanceInputSourceSchema).max(20).default([]),
  business_objectives: z.array(z.object({
    id: SourceIdSchema,
    name: z.string().trim().min(1).max(200),
    metric_id: SourceIdSchema,
    target_value: z.number().finite(),
    actual_value: z.number().finite().optional(),
    unit: z.string().trim().min(1).max(40),
  }).strict()).max(100).default([]),
}).strict().superRefine((input, context) => {
  if (!input.transactions.length && !input.sources.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'transactions or sources are required' })
  }
  if (Date.parse(input.period.from) >= Date.parse(input.period.to)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['period'], message: 'period.from must be before period.to' })
  }
})

export interface FinanceIngestionIssue {
  source_id: string
  location: string
  code: 'EMPTY_ROW' | 'INVALID_DATE' | 'INVALID_AMOUNT' | 'INVALID_TYPE' | 'INVALID_TRANSACTION' | 'INVALID_SOURCE'
  message: string
}

export interface FinanceIngestionResult {
  transactions: FinanceTransaction[]
  rejected: FinanceIngestionIssue[]
  warnings: string[]
}

const ALIASES = {
  status: ['status', 'статус', 'holat'],
  date: ['date', 'sana', 'дата'],
  type: ['type', 'operationtype', 'tur', 'тип'],
  amountMinor: ['amountminor', 'summaminor', 'суммаминор'],
  amount: ['amount', 'summa', 'сумма'],
  currency: ['currency', 'valyuta', 'валюта'],
  account: ['account', 'accountid', 'schet', 'счет', 'счёт'],
  fromAccount: ['fromaccount', 'fromaccountid', 'soscheta', 'сосчета', 'со счета'],
  toAccount: ['toaccount', 'toaccountid', 'naschet', 'насчет', 'на счет'],
  category: ['category', 'categoryname', 'statya', 'статья', 'kategoriya', 'категория'],
  categoryGroup: ['categorygroup', 'group', 'группа'],
  description: ['description', 'note', 'comment', 'kommentariy', 'комментарий', 'назначение'],
  reference: ['reference', 'transactionreference', 'bankreference', 'номер', 'документ'],
  project: ['project', 'projectid', 'proyekt', 'проект'],
  counterparty: ['counterparty', 'counterpartyname', 'kontragent', 'контрагент'],
} as const

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[ё]/g, 'е').replace(/[^a-zа-я0-9]+/giu, '')
}

function valueFor(row: Record<string, unknown>, aliases: readonly string[]): unknown {
  const accepted = new Set(aliases.map(normalizedKey))
  for (const [key, value] of Object.entries(row)) if (accepted.has(normalizedKey(key))) return value
  return undefined
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

function entityId(value: unknown, fallback: string): string {
  const raw = text(value).toLowerCase()
  const slug = raw.replace(/[^a-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100)
  if (slug) return slug
  if (!raw) return fallback
  let hash = 2166136261
  for (const char of raw) { hash ^= char.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619) }
  return `${fallback}-${(hash >>> 0).toString(16)}`
}

function parseDirection(value: unknown, category: unknown): 'inflow' | 'outflow' | 'transfer' | null {
  const source = (text(value) || text(category)).toLowerCase()
  if (/^(transfer|перевод|o['’‘]?tkazma)$/.test(source)) return 'transfer'
  if (/^(income|inflow|доход|kirim|daromad)$/.test(source)) return 'inflow'
  if (/^(expense|outflow|расход|chiqim|xarajat)$/.test(source)) return 'outflow'
  return null
}

function categoryGroup(value: unknown): 'revenue' | 'cost_of_sales' | 'payroll' | 'marketing' | 'infrastructure' | 'software_subscription' | 'office' | 'tax' | 'bank_fee' | 'debt' | 'capital_expenditure' | 'owner_draw' | 'other' {
  const raw = text(value).toLowerCase()
  if (/revenue|income|доход|daromad/.test(raw)) return 'revenue'
  if (/salary|payroll|зарплат|оклад|oylik/.test(raw)) return 'payroll'
  if (/marketing|маркетинг|reklama/.test(raw)) return 'marketing'
  if (/server|cloud|infra|сервер/.test(raw)) return 'infrastructure'
  if (/subscription|software|подписк|saas/.test(raw)) return 'software_subscription'
  if (/tax|налог|soliq/.test(raw)) return 'tax'
  if (/bank|commission|комисси/.test(raw)) return 'bank_fee'
  if (/office|офис/.test(raw)) return 'office'
  if (/debt|кредит|loan|qarz/.test(raw)) return 'debt'
  if (/capex|capital|основн.*средств/.test(raw)) return 'capital_expenditure'
  if (/cost of sales|себестоим/.test(raw)) return 'cost_of_sales'
  return 'other'
}

function parseCsv(content: string, forcedDelimiter?: ',' | ';' | '\t'): Record<string, unknown>[] {
  content = content.replace(/^\uFEFF/, '')
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const delimiters: Array<',' | ';' | '\t'> = [',', ';', '\t']
  const delimiter = forcedDelimiter ?? delimiters.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let closedQuote = false
  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (char === '"') {
      if (quoted && content[index + 1] === '"') { cell += '"'; index++ }
      else if (quoted) { quoted = false; closedQuote = true }
      else { if (cell || closedQuote) throw new Error('INVALID_CSV'); quoted = true }
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = ''; closedQuote = false
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[index + 1] === '\n') index++
      row.push(cell); cell = ''; closedQuote = false
      rows.push(row)
      if (rows.length > 10_002) throw new Error('CSV_LIMIT')
      row = []
    } else { if (closedQuote) throw new Error('INVALID_CSV'); cell += char }
  }
  if (quoted) throw new Error('INVALID_CSV')
  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  const headers = rows.shift()?.map((header) => header.trim()) ?? []
  if (!headers.length || headers.some(header => !header) || new Set(headers.map(normalizedKey)).size !== headers.length) throw new Error('INVALID_CSV_HEADERS')
  return rows.map((values) => {
    if (values.every(value => !value.trim())) return {}
    if (values.length !== headers.length) throw new Error('INVALID_CSV_WIDTH')
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]))
  })
}

interface LocatedRow { row: Record<string, unknown>; location: string; page?: number; sheet?: string; sourceRow: number; sourceKind: 'csv' | 'xlsx' | 'pdf' }

function* rowsFromSource(source: z.infer<typeof FinanceInputSourceSchema>): Generator<LocatedRow> {
  if (source.format === 'csv') {
    for (const [index, row] of parseCsv(source.content, source.delimiter).entries()) yield { row, location: `row:${index + 2}`, sourceRow: index + 2, sourceKind: 'csv' }
  } else if (source.format === 'excel_json') {
    for (const sheet of source.sheets) for (const [index, row] of sheet.rows.entries()) yield { row, location: `sheet:${sheet.name}:row:${index + 2}`, sheet: sheet.name, sourceRow: index + 2, sourceKind: 'xlsx' }
  } else for (const page of source.pages) for (const [tableIndex, table] of page.tables.entries()) for (const [index, row] of table.entries()) yield { row, location: `page:${page.page}:table:${tableIndex + 1}:row:${index + 1}`, page: page.page, sourceRow: index + 1, sourceKind: 'pdf' }
}

function normalizeRow(
  row: LocatedRow,
  source: z.infer<typeof FinanceInputSourceSchema>,
  workspaceId: string,
  rowIndex: number,
): { transaction?: FinanceTransaction; issue?: FinanceIngestionIssue } {
  const keys = Object.keys(row.row).map(normalizedKey)
  if (Object.values(row.row).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
      Object.values(ALIASES).some(aliases => keys.filter(key => aliases.map(normalizedKey).includes(key)).length > 1)) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_TRANSACTION', message: 'ambiguous columns or non-scalar values' } }
  const date = financeImportDate(valueFor(row.row, ALIASES.date))
  if (!date) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_DATE', message: 'transaction date is missing or invalid' } }
  const categoryName = text(valueFor(row.row, ALIASES.category))
  const direction = parseDirection(valueFor(row.row, ALIASES.type), categoryName)
  if (!direction) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_TYPE', message: 'operation type is not recognized' } }
  const minorValue = valueFor(row.row, ALIASES.amountMinor), majorValue = valueFor(row.row, ALIASES.amount)
  const rawMinor = financeAmountMinor(minorValue, 1), rawMajor = financeAmountMinor(majorValue, source.amount_scale)
  if (direction !== 'outflow' && (rawMinor ?? rawMajor ?? 0) < 0) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_AMOUNT', message: 'negative amount contradicts the declared income or transfer direction' } }
  if ((text(minorValue) && rawMinor === null) || (text(majorValue) && rawMajor === null) || (rawMinor !== null && rawMajor !== null && rawMinor !== rawMajor)) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_AMOUNT', message: 'amount cannot be represented exactly in minor units' } }
  const amountMinor = rawMinor !== null ? Math.abs(rawMinor) : rawMajor !== null ? Math.abs(rawMajor) : null
  if (!amountMinor) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_AMOUNT', message: 'amount is missing, zero or invalid' } }
  const statusValue = text(valueFor(row.row, ALIASES.status)).toLowerCase()
  const status = statusValue || 'posted'
  if (!['posted', 'pending', 'reversed'].includes(status)) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_TRANSACTION', message: 'status must be posted, pending or reversed' } }
  const account = entityId(valueFor(row.row, ALIASES.account), source.default_account_id ?? 'account-unknown')
  const reference = text(valueFor(row.row, ALIASES.reference))
  const evidence = {
    source_id: source.source_id,
    source_kind: row.sourceKind,
    locator: { ...(row.page ? { page: row.page } : {}), ...(row.sheet ? { sheet: row.sheet } : {}), row: row.sourceRow, ...(reference ? { transaction_reference: reference } : {}) },
  }
  const common = {
    transaction_id: `${source.source_id}:${rowIndex + 1}`,
    workspace_id: workspaceId,
    occurred_at: date,
    amount_minor: amountMinor,
    currency: text(valueFor(row.row, ALIASES.currency)).toUpperCase() || source.default_currency,
    status,
    counterparty_name: text(valueFor(row.row, ALIASES.counterparty)) || undefined,
    project_id: text(valueFor(row.row, ALIASES.project)) ? entityId(valueFor(row.row, ALIASES.project), 'project-unknown') : undefined,
    description: text(valueFor(row.row, ALIASES.description)),
    cash_flow_period: date.slice(0, 7),
    source: {
      source_id: source.source_id,
      source_kind: row.sourceKind,
      imported_at: source.imported_at,
      source_row: row.sourceRow,
      source_page: row.page,
      external_id: reference || undefined,
    },
    evidence: [evidence],
  }
  const candidate = direction === 'transfer'
    ? { ...common, direction, from_account_id: entityId(valueFor(row.row, ALIASES.fromAccount), account), to_account_id: entityId(valueFor(row.row, ALIASES.toAccount), 'account-unknown') }
    : {
        ...common, direction, account_id: account,
        category: categoryName ? {
          id: entityId(categoryName, 'uncategorized'), name: categoryName,
          group: categoryGroup(valueFor(row.row, ALIASES.categoryGroup) || categoryName),
        } : undefined,
      }
  const parsed = FinanceTransactionSchema.safeParse(candidate)
  return parsed.success
    ? { transaction: parsed.data }
    : { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_TRANSACTION', message: parsed.error.issues[0]?.message ?? 'transaction is invalid' } }
}

export function ingestFinanceSources(
  sources: z.infer<typeof FinanceInputSourceSchema>[],
  workspaceId: string,
): FinanceIngestionResult {
  const transactions: FinanceTransaction[] = []
  const rejected: FinanceIngestionIssue[] = []
  const warnings: string[] = []
  let processed = 0
  for (const source of sources) {
    // No silent loss of text-only fragments, and no ambiguous evidence addresses.
    if (source.format === 'pdf_json') {
      const pages = new Set<number>()
      let invalid = false
      for (const page of source.pages) {
        if (pages.has(page.page) || page.tables.length > 1 || page.text.trim()) {
          rejected.push({ source_id: source.source_id, location: `page:${page.page}`, code: 'INVALID_SOURCE', message: 'PDF JSON requires unique pages, one table per page and no unparsed text' })
          invalid = true
        }
        pages.add(page.page)
      }
      if (invalid) continue
    }
    if (source.format === 'excel_json' && new Set(source.sheets.map(sheet => sheet.name.toLowerCase())).size !== source.sheets.length) {
      rejected.push({ source_id: source.source_id, location: 'sheets', code: 'INVALID_SOURCE', message: 'sheet names must be unique' })
      continue
    }
    let index = 0, nonempty = 0
    try {
      for (const row of rowsFromSource(source)) {
        if (++processed > 10_000) { warnings.push('The 10,000-row request limit was exceeded; no partial report is permitted'); break }
        const rowIndex = index++
        if (!Object.values(row.row).some((value) => text(value))) continue
        nonempty++
        const normalized = normalizeRow(row, source, workspaceId, rowIndex)
        if (normalized.transaction) transactions.push(normalized.transaction)
        if (normalized.issue) rejected.push(normalized.issue)
      }
    } catch { rejected.push({ source_id: source.source_id, location: 'source', code: 'INVALID_SOURCE', message: 'source structure is invalid or exceeds the row limit' }) }
    if (!nonempty) warnings.push(`${source.source_id}: source has no supported table rows`)
    if (processed > 10_000) break
  }
  return { transactions, rejected, warnings }
}

export type FinanceAnalyzeApiInput = z.infer<typeof FinanceAnalyzeApiInputSchema>
export type FinanceInputSource = z.infer<typeof FinanceInputSourceSchema>
