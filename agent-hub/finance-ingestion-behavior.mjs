import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FinanceInputSourceSchema, ingestFinanceSources } from '../supabase/functions/_shared/financeIngestion.ts'
import { CashFlowAnalyticsRequestSchema } from '../supabase/functions/_shared/financeCashFlow.ts'
import { assembleCashFlowAnalysis, calculateCashFlow, validateFinanceNarrative } from '../supabase/functions/_shared/financeAnalyzer.ts'
import { BusinessOrderDraftRequestSchema, validateOrderDraftAgainstRequest } from '../supabase/functions/_shared/hrOrderGenerator.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const importedAt = '2026-08-30T12:00:00Z'
const csv = FinanceInputSourceSchema.parse({
  format: 'csv', source_id: 'bank-august', imported_at: importedAt, default_currency: 'UZS', amount_scale: 100,
  content: [
    'Дата;Тип;Сумма;Счет;Статья;Группа;Комментарий;Номер',
    '01.08.2026;ДОХОД;1000000;main;Продажи;Доход;Оплата клиента;R-1',
    '02.08.2026;РАСХОД;250000;main;Cloud;Серверы;Compute;R-2',
    'bad-date;РАСХОД;100;main;Office;Офис;Invalid;R-3',
  ].join('\n'),
})
const excel = FinanceInputSourceSchema.parse({
  format: 'excel_json', source_id: 'budget-sheet', imported_at: importedAt, default_currency: 'UZS', amount_scale: 100,
  sheets: [{ name: 'Operations', rows: [{ date: '2026-08-03', type: 'expense', amount: 50000, account: 'main', category: 'Marketing', group: 'marketing', reference: 'X-1' }] }],
})
const pdf = FinanceInputSourceSchema.parse({
  format: 'pdf_json', source_id: 'statement-pdf', imported_at: importedAt, default_currency: 'UZS', amount_scale: 100,
  pages: [{ page: 4, text: 'Statement', tables: [[{ date: '2026-08-04', type: 'expense', amount: 10000, account: 'main', category: 'Bank fee', group: 'bank fee', reference: 'P-1' }]] }],
})
const ingested = ingestFinanceSources([csv, excel, pdf], workspaceId)
assert.equal(ingested.transactions.length, 4, JSON.stringify(ingested.rejected))
assert.equal(ingested.rejected.length, 1)
assert.equal(ingested.rejected[0].code, 'INVALID_DATE')
assert.equal(ingested.transactions[0].amount_minor, 100_000_000)
assert.equal(ingested.transactions[1].category?.group, 'infrastructure')
assert.equal(ingested.transactions[3].evidence[0].locator.page, 4)

const request = CashFlowAnalyticsRequestSchema.parse({
  workspace_id: workspaceId,
  period: { from: '2026-08-01T00:00:00+05:00', to: '2026-09-01T00:00:00+05:00' },
  base_currency: 'UZS', opening_balance_minor: 50_000_000, transactions: ingested.transactions,
})
const deterministic = calculateCashFlow(request)
assert.equal(deterministic.summary.inflow_minor, 100_000_000)
assert.equal(deterministic.summary.outflow_minor, 31_000_000)
assert.equal(deterministic.summary.net_cash_flow_minor, 69_000_000)
assert.equal(deterministic.summary.closing_balance_minor, 119_000_000)

const expense = ingested.transactions.find((transaction) => transaction.direction === 'outflow')
assert.ok(expense && expense.direction === 'outflow')
const evidence = expense.evidence[0]
const narrative = {
  impact_assessments: [{
    title: 'Cloud outcome is not measured', explanation: 'The payment is evidenced but no outcome metric is attached.', confidence: 0.9,
    evidence: [evidence], category_id: expense.category.id, spend_minor: expense.amount_minor,
    impact_status: 'unknown', roi_ratio: null, attribution_quality: 'insufficient_data', metric_changes: [],
  }],
  inefficiencies: [],
  recommendations: [{
    title: 'Attach workload metrics', explanation: 'Review utilization before changing the service.', confidence: 0.85,
    evidence: [evidence], action: 'investigate', estimated_saving_minor: null, owner_role: 'CFO', priority: 'high', requires_human_approval: true,
  }],
}
const checked = validateFinanceNarrative(narrative, request)
assert.ok(checked.narrative)
assert.equal(validateFinanceNarrative({ ...narrative, recommendations: [{ ...narrative.recommendations[0], evidence: [{ ...evidence, source_id: 'invented' }] }] }, request).narrative, null)
const output = assembleCashFlowAnalysis(request, checked.narrative)
assert.equal(output.summary.closing_balance_minor, 119_000_000)
assert.equal(output.recommendations[0].requires_human_approval, true)

const orderRequest = BusinessOrderDraftRequestSchema.parse({
  workspace_id: workspaceId, order_type: 'bonus', locale: 'ru', effective_date: '2026-09-01',
  organization: { legal_name: 'Nemo Test LLC' }, subject: { employee_id: 'employee-1', employee_name: 'Test Employee' },
  facts: { amount_minor: 10_000_000, currency: 'UZS' }, related_transaction_ids: ['bank-august:1'], evidence: [evidence],
  requested_signatories: [{ role: 'Director' }],
})
const orderDraft = {
  draft_id: '22222222-2222-4222-8222-222222222222', order_type: 'bonus', locale: 'ru', title: 'Проект приказа о премии',
  legal_basis: [{ text: 'Основание из предоставленного документа', evidence: [evidence] }],
  clauses: [{ number: 1, text: 'Передать проект на проверку директору.' }],
  signatories: [{ role: 'Director', signature_status: 'pending' }], attachments: [], missing_required_fields: [],
  status: 'draft_requires_review', requires_human_approval: true, generated_at: importedAt,
}
assert.ok(validateOrderDraftAgainstRequest(orderDraft, orderRequest).draft)
assert.equal(validateOrderDraftAgainstRequest({ ...orderDraft, requires_human_approval: false }, orderRequest).draft, null)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const endpoint = fs.readFileSync(path.join(root, 'supabase/functions/finance-analyze-cashflow/index.ts'), 'utf8')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'supabase/functions/deployment-manifest.json'), 'utf8'))
const vercel = fs.readFileSync(path.join(root, 'vercel.json'), 'utf8')
assert.match(endpoint, /FinanceAnalyzeApiInputSchema\.safeParse/)
assert.match(endpoint, /validateFinanceNarrative/)
assert.match(endpoint, /record_token_usage/)
assert.match(endpoint, /WORKSPACE_FORBIDDEN/)
assert.ok(manifest.authenticated.includes('finance-analyze-cashflow'))
assert.match(vercel, /\/api\/finance\/analyze-cashflow/)

console.log('[OK] Finance ingestion, deterministic cash flow, grounded narrative and HR order contracts')
