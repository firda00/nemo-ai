import { z } from 'zod'
import { FinanceTransactionSchema, type FinanceTransaction } from './financeCashFlow.ts'

const SourceIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const RowSchema = z.record(z.unknown())

const SourceBaseSchema = z.object({
  source_id: SourceIdSchema,
  imported_at: z.string().datetime({ offset: true }),
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
  period: z.object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }).strict(),
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
  code: 'EMPTY_ROW' | 'INVALID_DATE' | 'INVALID_AMOUNT' | 'INVALID_TYPE' | 'INVALID_TRANSACTION'
  message: string
}

export interface FinanceIngestionResult {
  transactions: FinanceTransaction[]
  rejected: FinanceIngestionIssue[]
  warnings: string[]
}

const ALIASES = {
  date: ['date', 'sana', 'дата'],
  type: ['type', 'operationtype', 'tur', 'kategoriya', 'категория', 'тип'],
  amountMinor: ['amountminor', 'summaminor', 'суммаминор'],
  amount: ['amount', 'summa', 'сумма'],
  currency: ['currency', 'valyuta', 'валюта'],
  account: ['account', 'accountid', 'schet', 'счет', 'счёт'],
  fromAccount: ['fromaccount', 'fromaccountid', 'soscheta', 'сосчета', 'со счета'],
  toAccount: ['toaccount', 'toaccountid', 'naschet', 'насчет', 'на счет'],
  category: ['category', 'categoryname', 'statya', 'статья'],
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
  const source = `${text(value)} ${text(category)}`.toLowerCase()
  if (/transfer|перевод|o['’]?tkazma/.test(source)) return 'transfer'
  if (/income|inflow|доход|kirim|daromad/.test(source)) return 'inflow'
  if (/expense|outflow|расход|chiqim|xarajat/.test(source)) return 'outflow'
  return null
}

function parseDate(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const isoDay = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoDay) return `${raw}T00:00:00+05:00`
  const localDay = raw.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/)
  if (localDay) return `${localDay[3]}-${localDay[2]}-${localDay[1]}T00:00:00+05:00`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  let raw = text(value).replace(/[\s\u00a0']/g, '')
  if (!raw) return null
  if (raw.includes(',') && raw.includes('.')) raw = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '')
  else if (raw.includes(',')) raw = /^-?\d+,\d{1,2}$/.test(raw) ? raw.replace(',', '.') : raw.replace(/,/g, '')
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
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
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  const delimiters: Array<',' | ';' | '\t'> = [',', ';', '\t']
  const delimiter = forcedDelimiter ?? delimiters.sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < content.length; index++) {
    const char = content[index]
    if (char === '"') {
      if (quoted && content[index + 1] === '"') { cell += '"'; index++ } else quoted = !quoted
    } else if (char === delimiter && !quoted) {
      row.push(cell); cell = ''
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && content[index + 1] === '\n') index++
      row.push(cell); cell = ''
      if (row.some((value) => value.trim())) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell)
  if (row.some((value) => value.trim())) rows.push(row)
  const headers = rows.shift()?.map((header) => header.trim()) ?? []
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

interface LocatedRow { row: Record<string, unknown>; location: string; page?: number; sheet?: string; sourceRow: number; sourceKind: 'csv' | 'xlsx' | 'pdf' }

function rowsFromSource(source: z.infer<typeof FinanceInputSourceSchema>): LocatedRow[] {
  if (source.format === 'csv') return parseCsv(source.content, source.delimiter).map((row, index) => ({ row, location: `row:${index + 2}`, sourceRow: index + 2, sourceKind: 'csv' }))
  if (source.format === 'excel_json') return source.sheets.flatMap((sheet) => sheet.rows.map((row, index) => ({ row, location: `sheet:${sheet.name}:row:${index + 2}`, sheet: sheet.name, sourceRow: index + 2, sourceKind: 'xlsx' as const })))
  return source.pages.flatMap((page) => page.tables.flatMap((table, tableIndex) => table.map((row, rowIndex) => ({ row, location: `page:${page.page}:table:${tableIndex + 1}:row:${rowIndex + 1}`, page: page.page, sourceRow: rowIndex + 1, sourceKind: 'pdf' as const }))))
}

function normalizeRow(
  row: LocatedRow,
  source: z.infer<typeof FinanceInputSourceSchema>,
  workspaceId: string,
  rowIndex: number,
): { transaction?: FinanceTransaction; issue?: FinanceIngestionIssue } {
  const date = parseDate(valueFor(row.row, ALIASES.date))
  if (!date) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_DATE', message: 'transaction date is missing or invalid' } }
  const categoryName = text(valueFor(row.row, ALIASES.category))
  const direction = parseDirection(valueFor(row.row, ALIASES.type), categoryName)
  if (!direction) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_TYPE', message: 'operation type is not recognized' } }
  const rawMinor = parseNumber(valueFor(row.row, ALIASES.amountMinor))
  const rawMajor = parseNumber(valueFor(row.row, ALIASES.amount))
  const amountMinor = rawMinor != null ? Math.round(Math.abs(rawMinor)) : rawMajor != null ? Math.round(Math.abs(rawMajor) * source.amount_scale) : null
  if (!amountMinor) return { issue: { source_id: source.source_id, location: row.location, code: 'INVALID_AMOUNT', message: 'amount is missing, zero or invalid' } }
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
    status: 'posted' as const,
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
  for (const source of sources) {
    const remaining = Math.max(0, 10_000 - transactions.length - rejected.length)
    if (!remaining) { warnings.push('Ingestion stopped at the 10,000-row request limit'); break }
    const allRows = rowsFromSource(source)
    const rows = allRows.slice(0, remaining)
    if (allRows.length > rows.length) warnings.push(`${source.source_id}: rows beyond the 10,000-row request limit were ignored`)
    if (!rows.length && source.format === 'pdf_json') warnings.push(`${source.source_id}: PDF JSON has no table rows; OCR text-only parsing is not enabled`)
    rows.forEach((row, index) => {
      if (!Object.values(row.row).some((value) => text(value))) return
      const normalized = normalizeRow(row, source, workspaceId, index)
      if (normalized.transaction) transactions.push(normalized.transaction)
      if (normalized.issue) rejected.push(normalized.issue)
    })
  }
  return { transactions, rejected, warnings }
}

export type FinanceAnalyzeApiInput = z.infer<typeof FinanceAnalyzeApiInputSchema>
