import { describe, expect, test, vi } from 'vitest'
vi.mock('../src/lib/supabase', () => ({ supabase: null }))
import { CashFlowAnalyticsRequestSchema, FinanceTransactionSchema } from '../supabase/functions/_shared/financeCashFlow'
import { FinanceAnalyzeApiInputSchema, FinanceInputSourceSchema, ingestFinanceSources } from '../supabase/functions/_shared/financeIngestion'
import { calculateCashFlow, buildFinanceAnalysisPrompt, validateFinanceNarrative, assembleCashFlowAnalysis } from '../supabase/functions/_shared/financeAnalyzer'
import { selectFinanceTransactions } from '../supabase/functions/_shared/financeSelection'
import { financeCalendarPeriod, FinanceInstantSchema, financeImportDate } from '../supabase/functions/_shared/financeTime'
import { financeAmountMinor, financeSafeSum } from '../supabase/functions/_shared/financeAmounts'
import { prepareFinanceAnalysis } from '../supabase/functions/_shared/financePreparation'
import { requestFinanceReport } from '../src/lib/financeReportClient'
import { formatFinanceMoney } from '../src/lib/financeMoney'

test('minor units remain exact at display boundaries', () => {
  const compact = (value: number) => formatFinanceMoney(value, 'UZS').replace(/\s/g, '')
  expect(compact(Number.MAX_SAFE_INTEGER)).toBe('90071992547409,91UZS')
  expect(compact(-Number.MAX_SAFE_INTEGER)).toBe('-90071992547409,91UZS')
  expect(compact(-1)).toBe('-0,01UZS')
  expect(compact(0)).toBe('0,00UZS')
  expect(formatFinanceMoney(Number.MAX_SAFE_INTEGER + 1, 'UZS')).toBe('—')
})

const workspace = '11111111-1111-4111-8111-111111111111'
const period = { from: '2026-08-01T00:00:00+05:00', to: '2026-09-01T00:00:00+05:00' }
const tx = (id: string, occurred_at = '2026-08-10T09:00:00+05:00', options = {}) => FinanceTransactionSchema.parse({
  transaction_id: id, workspace_id: workspace, occurred_at, posted_at: '2027-01-01T00:00:00Z', amount_minor: 10000, currency: 'UZS',
  status: 'posted', direction: 'outflow', account_id: 'main', cash_flow_period: '2026-12', description: id,
  category: { id: 'office', name: 'Office', group: 'office' },
  source: { source_id: id, source_kind: 'manual', imported_at: '2026-09-05T00:00:00Z' },
  evidence: [{ source_id: id, source_kind: 'manual', locator: { transaction_reference: id }, excerpt: id }], ...options,
})
const request = (transactions = [tx('included')], options = {}) => CashFlowAnalyticsRequestSchema.parse({ workspace_id: workspace, period, base_currency: 'UZS', opening_balance_minor: 20000, transactions, ...options })
const api = (transactions = [tx('included')], options = {}) => FinanceAnalyzeApiInputSchema.parse({ workspace_id: workspace, period, base_currency: 'UZS', opening_balance_minor: 20000, transactions, ...options })
const empty = { impact_assessments: [], inefficiencies: [], recommendations: [] }
const source = (content: string) => FinanceInputSourceSchema.parse({ format: 'csv', source_id: 'csv', imported_at: '2026-09-05T00:00:00Z', content })
const validCsv = 'date;type;amount;account;category;status\n2026-08-01;income;100.01;main;Sales;posted'

describe('cash-flow period and exact values', () => {
  test('one half-open absolute interval selects occurred_at, independently of posted_at and labels', () => {
    const original = request([
      tx('before', '2026-07-31T18:59:59.999Z'), tx('start', '2026-07-31T19:00:00Z', { direction: 'inflow', amount_minor: 30000 }),
      tx('same-instant', '2026-08-01T03:00:00+08:00'), tx('last', '2026-08-31T18:59:59.999Z'),
      tx('end', '2026-08-31T19:00:00Z'), tx('pending', undefined, { status: 'pending' }), tx('reversed', undefined, { status: 'reversed' }),
      tx('outside-pending', '2026-07-01T00:00:00Z', { status: 'pending' }),
    ])
    const before = JSON.stringify(original)
    const selected = selectFinanceTransactions(original)
    expect(selected.transactions.map(t => t.transaction_id)).toEqual(['start', 'same-instant', 'last'])
    expect(selected.selection).toMatchObject({ included_count: 3, outside_period_count: 3, pending_in_period_count: 1, reversed_in_period_count: 1, input_count: 8 })
    expect(calculateCashFlow(original).summary).toMatchObject({ inflow_minor: 30000, outflow_minor: 20000, net_cash_flow_minor: 10000, closing_balance_minor: 30000 })
    expect(JSON.stringify(original)).toBe(before)
  })
  test('month/day boundaries are calendar-correct with explicit Tashkent offset', () => {
    expect(financeCalendarPeriod('2026-08', 'month')).toEqual(period)
    expect(financeCalendarPeriod('2028-02-29', 'day')).toEqual({ from: '2028-02-29T00:00:00+05:00', to: '2028-03-01T00:00:00+05:00' })
    expect(financeCalendarPeriod('2026-12', 'month')?.to).toBe('2027-01-01T00:00:00+05:00')
    for (const value of ['2026-02-29', '2026-02-30', '9999-12-31', '2026-2-01']) expect(financeCalendarPeriod(value, 'day')).toBeNull()
    expect(financeCalendarPeriod('9999-12', 'month')).toBeNull()
  })
  test('invalid dates, naive timestamps and sub-millisecond values cannot cross a boundary', () => {
    for (const value of ['2026-02-30T00:00:00Z', '2026-08-01T24:00:00Z', '2026-08-01T00:00:00', '2026-08-01T00:00:00.0001Z', '2026-08-01T00:00:00+25:00']) {
      expect(FinanceInstantSchema.safeParse(value).success).toBe(false)
      expect(financeImportDate(value)).toBeNull()
    }
    expect(financeImportDate('01.08.2026')).toBe('2026-08-01T00:00:00+05:00')
    expect(financeImportDate('08/01/2026')).toBeNull()
    expect(financeImportDate(46204)).toBeNull()
  })
  test('minor-unit parsing is exact and never rounds or guesses grouping', () => {
    for (const [value, expected] of [['1.01', 101], ['-1,23', -123], ['1 234,56', 123456], ['90071992547409.91', Number.MAX_SAFE_INTEGER]] as const) expect(financeAmountMinor(value)).toBe(expected)
    for (const value of ['1.005', '1,234', '1,234.56', '90071992547409.92', '1e3', '', {}, Infinity]) expect(financeAmountMinor(value)).toBeNull()
    expect(financeAmountMinor('1.5', 1)).toBeNull()
    expect(financeSafeSum([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])).toBe(0)
    expect(() => financeSafeSum([Number.MAX_SAFE_INTEGER, 2])).toThrow('AMOUNT_OVERFLOW')
  })
  test('aggregate or closing-balance overflow refuses during preparation', () => {
    const huge = [tx('h1', undefined, { amount_minor: Number.MAX_SAFE_INTEGER, direction: 'inflow' }), tx('h2', undefined, { amount_minor: 2, direction: 'inflow' })]
    expect(prepareFinanceAnalysis(api(huge), workspace)).toMatchObject({ ok: false, code: 'AMOUNT_OVERFLOW' })
    expect(prepareFinanceAnalysis(api([huge[0]], { opening_balance_minor: 1 }), workspace)).toMatchObject({ ok: false, code: 'AMOUNT_OVERFLOW' })
  })
  test('empty periods are explicit and have no misleading perfect completeness', () => {
    const outside = [tx('outside', '2026-07-01T00:00:00Z')]
    expect(calculateCashFlow(request(outside)).data_quality.completeness_score).toBe(0)
    expect(prepareFinanceAnalysis(api(outside), workspace)).toMatchObject({ ok: false, code: 'NO_TRANSACTIONS_IN_PERIOD' })
    expect(() => request([tx('duplicate'), tx('duplicate')])).toThrow()
  })
})

describe('source completeness and model evidence', () => {
  test('local category headers are independent of direction and conflicting amount signs refuse', () => {
    for (const csv of ['Дата;Тип;Сумма;Категория\n2026-08-01;expense;-5;Аренда', 'sana;tur;summa;kategoriya\n2026-08-01;expense;5;Ijara']) {
      const prepared = prepareFinanceAnalysis(api([], { sources: [source(csv)] }), workspace)
      expect(prepared.ok).toBe(true)
      if (prepared.ok) expect(prepared.transactions[0].category?.name).toMatch(/Аренда|Ijara/)
    }
    expect(prepareFinanceAnalysis(api([], { sources: [source('date;type;amount\n2026-08-01;income;-500')] }), workspace)).toMatchObject({ ok: false, code: 'INGESTION_INCOMPLETE' })
  })
  test('transaction citations do not establish measured outcomes or ROI', () => {
    const expense = tx('expense')
    const base = { title: 'Impact', explanation: 'Impact', confidence: 1, evidence: expense.evidence, category_id: 'office', spend_minor: 10000, impact_status: 'positive', roi_ratio: 999, attribution_quality: 'measured', metric_changes: [{ metric_id: 'invented', before: 1, after: 1000, delta: 999, unit: 'sales' }] }
    expect(validateFinanceNarrative({ ...empty, impact_assessments: [base] }, request([expense])).narrative).toBeNull()
    const recommendation = { title: 'Save', explanation: 'Save', confidence: 1, evidence: expense.evidence, action: 'investigate', estimated_saving_minor: 10001, owner_role: 'CFO', priority: 'low', requires_human_approval: true }
    expect(validateFinanceNarrative({ ...empty, recommendations: [recommendation] }, request([expense])).narrative).toBeNull()
  })
  test('partial PDF pages and ambiguous table or sheet addresses refuse the entire import', () => {
    const row = { date: '2026-08-01', type: 'expense', amount: '1' }
    const pdf = (pages: unknown[]) => FinanceInputSourceSchema.parse({ format: 'pdf_json', source_id: 'pdf', imported_at: '2026-09-05T00:00:00Z', pages })
    for (const pages of [
      [{ page: 1, tables: [[row]] }, { page: 2, text: 'Unparsed debit 9900' }],
      [{ page: 1, tables: [[row]], text: 'Unparsed debit 9900' }],
      [{ page: 1, tables: [[row], [row]] }],
      [{ page: 1, tables: [[row]] }, { page: 1, tables: [[row]] }],
    ]) expect(prepareFinanceAnalysis(api([], { sources: [pdf(pages)] }), workspace)).toMatchObject({ ok: false, code: 'INGESTION_INCOMPLETE' })
    expect(prepareFinanceAnalysis(api([], { sources: [pdf([{ page: 1, tables: [[row]] }, { page: 2, tables: [[row]] }])] }), workspace).ok).toBe(true)
    const duplicateSheets = FinanceInputSourceSchema.parse({ format: 'excel_json', source_id: 'xlsx', imported_at: '2026-09-05T00:00:00Z', sheets: [{ name: 'Main', rows: [row] }, { name: 'main', rows: [row] }] })
    expect(prepareFinanceAnalysis(api([], { sources: [duplicateSheets] }), workspace)).toMatchObject({ ok: false, code: 'INGESTION_INCOMPLETE' })
  })
  test('findings cannot borrow a cheap transaction citation to claim another expense or category', () => {
    const cheap = tx('cheap', undefined, { amount_minor: 100 }), costly = tx('costly')
    const req = request([cheap, costly])
    const base = { title: 'Review', explanation: 'Review', confidence: 0.8, evidence: cheap.evidence }
    const finding = { ...base, severity: 'low', affected_transaction_ids: ['costly'], avoidable_amount_minor: 10000, reason_code: 'other' }
    expect(validateFinanceNarrative({ ...empty, inefficiencies: [finding] }, req).narrative).toBeNull()
    expect(validateFinanceNarrative({ ...empty, inefficiencies: [{ ...finding, evidence: costly.evidence }] }, req).narrative).not.toBeNull()
    const impact = { ...base, category_id: 'office', spend_minor: 10000, impact_status: 'unknown', roi_ratio: null, attribution_quality: 'insufficient_data', metric_changes: [] }
    expect(validateFinanceNarrative({ ...empty, impact_assessments: [impact] }, req).narrative).toBeNull()
    expect(validateFinanceNarrative({ ...empty, impact_assessments: [{ ...impact, spend_minor: 100 }] }, req).narrative).not.toBeNull()
  })
  test('CSV statuses are honored and every source error blocks partial reports', () => {
    const statuses = source(validCsv + '\n2026-08-02;expense;10;main;Office;pending\n2026-08-03;expense;20;main;Office;reversed')
    const prepared = prepareFinanceAnalysis(api([], { sources: [statuses] }), workspace)
    expect(prepared.ok).toBe(true)
    if (prepared.ok) expect(prepared.selection).toMatchObject({ included_count: 1, pending_in_period_count: 1, reversed_in_period_count: 1 })
    for (const bad of [validCsv.replace('2026-08-01', '2026-02-30'), validCsv.replace('posted', 'maybe'), validCsv.replace('100.01', '1.005'), validCsv + '\n"unclosed', validCsv.replace('date;', 'date;date;'), validCsv.replace('date;', 'date;Дата;'), validCsv.replace('main;', 'main;extra;')]) {
      expect(prepareFinanceAnalysis(api([tx('good')], { sources: [source(bad)] }), workspace)).toMatchObject({ ok: false, code: 'INGESTION_INCOMPLETE' })
    }
    const noRows = FinanceInputSourceSchema.parse({ format: 'pdf_json', source_id: 'text-only', imported_at: '2026-09-05T00:00:00Z', pages: [{ page: 1, text: 'Important amount 9999' }] })
    expect(prepareFinanceAnalysis(api([tx('good')], { sources: [noRows] }), workspace)).toMatchObject({ ok: false, code: 'INGESTION_INCOMPLETE' })
  })
  test('10,001 input rows cannot silently become a 10,000-row report', () => {
    const many = source('date;type;amount\n' + Array.from({ length: 10001 }, () => '2026-08-01;income;1').join('\n'))
    expect(prepareFinanceAnalysis(api([], { sources: [many] }), workspace)).toMatchObject({ ok: false, code: 'INGESTION_INCOMPLETE' })
    const minor = source('date;type;amountminor;amount\n2026-08-01;income;1.5;1')
    expect(ingestFinanceSources([minor], workspace).rejected[0]?.code).toBe('INVALID_AMOUNT')
  })
  test('the prompt and validator use only included, posted, actually supplied evidence', () => {
    const chosen = tx('chosen'), outside = tx('OUTSIDE_MARKER', '2026-07-01T00:00:00Z'), pending = tx('PENDING_MARKER', undefined, { status: 'pending' })
    const req = request([chosen, outside, pending])
    const recommendation = (evidence = chosen.evidence) => ({ ...empty, recommendations: [{ title: 'Review', explanation: 'Review the source', confidence: 0.8, evidence, action: 'investigate', estimated_saving_minor: null, owner_role: 'User', priority: 'low', requires_human_approval: true }] })
    expect(buildFinanceAnalysisPrompt(req)).not.toContain('OUTSIDE_MARKER')
    expect(buildFinanceAnalysisPrompt(req)).not.toContain('PENDING_MARKER')
    expect(validateFinanceNarrative(recommendation(), req).narrative).not.toBeNull()
    for (const evidence of [outside.evidence, pending.evidence, [{ ...chosen.evidence[0], excerpt: 'fabricated excerpt' }]]) expect(validateFinanceNarrative(recommendation(evidence), req).narrative).toBeNull()
    const many = request(Array.from({ length: 251 }, (_, i) => tx('tx' + i)))
    expect(validateFinanceNarrative(recommendation(many.transactions[250].evidence), many).narrative).toBeNull()
  })
  test('full output limits are checked before model work, while 2,001 valid unclassified rows remain usable', () => {
    const unknown = Array.from({ length: 2001 }, (_, i) => tx('t' + i, undefined, { category: undefined, evidence: [] }))
    expect(prepareFinanceAnalysis(api(unknown), workspace).ok).toBe(true)
    const categories = Array.from({ length: 501 }, (_, i) => tx('cat' + i, undefined, { category: { id: 'cat' + i, name: 'Category ' + i, group: 'other' } }))
    expect(prepareFinanceAnalysis(api(categories), workspace)).toMatchObject({ ok: false, code: 'REPORT_LIMIT_EXCEEDED' })
  })
})

describe('finance response identity and consistency', () => {
  const result = () => {
    const prepared = prepareFinanceAnalysis(api(), workspace)
    if (!prepared.ok) throw new Error(prepared.code)
    return { analysis: assembleCashFlowAnalysis(prepared.request, empty), transactions: prepared.transactions, selection: prepared.selection }
  }
  const scope = () => ({ userId: 'u1', signal: new AbortController().signal, alive: () => true })
  const session = async () => ({ userId: 'u1', token: 'synthetic-test-token' })
  test('authenticated response supplies the exact selected rows and reconciled values', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(result())))
    expect((await requestFinanceReport(api(), scope(), { session, fetch: fetcher })).transactions[0].transaction_id).toBe('included')
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-test-token')
  })
  test('identity mismatch never sends source data under a new user token', async () => {
    const fetcher = vi.fn()
    await expect(requestFinanceReport(api(), scope(), { session: async () => ({ userId: 'u2', token: 'synthetic' }), fetch: fetcher })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  test('abort and timeout settle even when dependencies ignore signals', async () => {
    const controller = new AbortController()
    const pending = requestFinanceReport(api(), { ...scope(), signal: controller.signal }, { session: () => new Promise(() => {}), timeoutMs: 1000 })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(requestFinanceReport(api(), scope(), { session, fetch: () => new Promise(() => {}), timeoutMs: 15 })).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
  test('wrong period, audit or transactions cannot be displayed beside valid-looking totals', async () => {
    for (const mutate of [
      (body: ReturnType<typeof result>) => { body.analysis.period = { from: '2026-09-01T00:00:00Z', to: '2026-10-01T00:00:00Z' } },
      (body: ReturnType<typeof result>) => { body.transactions[0].amount_minor += 1 },
      (body: ReturnType<typeof result>) => { body.selection.audit[0].transaction_id = 'different' },
    ]) {
      const body = result(); mutate(body)
      await expect(requestFinanceReport(api(), scope(), { session, fetch: async () => new Response(JSON.stringify(body)) })).rejects.toBeTruthy()
    }
  })
  test('signal-aware transport and non-JSON proxy errors preserve typed failures', async () => {
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
    await expect(requestFinanceReport(api(), scope(), { session, fetch: fetcher, timeoutMs: 15 })).rejects.toMatchObject({ code: 'TIMEOUT' })
    await expect(requestFinanceReport(api(), scope(), { session, fetch: async () => new Response('<html>502</html>', { status: 502 }) })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
