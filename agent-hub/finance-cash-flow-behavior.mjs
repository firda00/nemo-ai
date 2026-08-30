import assert from 'node:assert/strict'
import {
  CashFlowAnalyticsOutputSchema,
  CashFlowAnalyticsRequestSchema,
  FinanceEvidenceRefSchema,
  FinanceTransactionSchema,
} from '../supabase/functions/_shared/financeCashFlow.ts'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const evidence = {
  source_id: 'statement-july', source_kind: 'bank_statement',
  locator: { page: 2, transaction_reference: 'BANK-42' }, excerpt: 'Cloud provider payment',
}
assert.equal(FinanceEvidenceRefSchema.parse(evidence).locator.page, 2)
assert.equal(FinanceEvidenceRefSchema.safeParse({ ...evidence, locator: {} }).success, false)

const outflow = FinanceTransactionSchema.parse({
  transaction_id: 'tx-42', workspace_id: workspaceId, direction: 'outflow',
  occurred_at: '2026-08-10T09:00:00+05:00', amount_minor: 125_000_00, currency: 'UZS',
  status: 'posted', account_id: 'bank-main',
  category: { id: 'cloud', name: 'Cloud servers', group: 'infrastructure' },
  description: 'Monthly compute', cash_flow_period: '2026-08',
  source: { source_id: 'statement-july', source_kind: 'bank_statement', imported_at: '2026-08-11T10:00:00Z', source_page: 2 },
  evidence: [evidence], impact_context: { spend_purpose: 'Host Nemo workloads', metric_ids: ['uptime'] },
})
assert.equal(outflow.direction, 'outflow')
assert.equal(outflow.tags.length, 0)
assert.equal(FinanceTransactionSchema.safeParse({ ...outflow, amount_minor: 12.5 }).success, false)
assert.equal(FinanceTransactionSchema.safeParse({ ...outflow, currency: 'sum' }).success, false)
assert.equal(FinanceTransactionSchema.safeParse({ ...outflow, direction: 'transfer', from_account_id: 'same', to_account_id: 'same', account_id: undefined }).success, false)

const request = CashFlowAnalyticsRequestSchema.parse({
  workspace_id: workspaceId,
  period: { from: '2026-08-01T00:00:00+05:00', to: '2026-09-01T00:00:00+05:00' },
  base_currency: 'UZS', opening_balance_minor: 2_000_000_00, transactions: [outflow],
})
assert.equal(request.transactions.length, 1)
assert.equal(CashFlowAnalyticsRequestSchema.safeParse({ ...request, base_currency: 'USD' }).success, false)
assert.equal(CashFlowAnalyticsRequestSchema.safeParse({ ...request, period: { from: request.period.to, to: request.period.from } }).success, false)

const finding = {
  title: 'Cloud spend needs attribution', explanation: 'No workload-level outcome is attached.', confidence: 0.9,
  evidence: [evidence],
}
const output = {
  period: request.period, currency: 'UZS',
  summary: {
    opening_balance_minor: 2_000_000_00, inflow_minor: 0, outflow_minor: 125_000_00,
    net_cash_flow_minor: -125_000_00, closing_balance_minor: 1_875_000_00, transfer_volume_minor: 0,
  },
  category_breakdown: [{ category_id: 'cloud', category_name: 'Cloud servers', direction: 'outflow', amount_minor: 125_000_00, share_of_direction: 1, transaction_count: 1 }],
  impact_assessments: [{ ...finding, category_id: 'cloud', spend_minor: 125_000_00, impact_status: 'unknown', roi_ratio: null, attribution_quality: 'insufficient_data', metric_changes: [] }],
  inefficiencies: [{ ...finding, severity: 'medium', affected_transaction_ids: ['tx-42'], avoidable_amount_minor: null, reason_code: 'unclassified' }],
  recommendations: [{ ...finding, action: 'investigate', estimated_saving_minor: null, owner_role: 'CFO', priority: 'high', requires_human_approval: true }],
  data_quality: { completeness_score: 0.75, uncategorized_transaction_ids: [], missing_evidence_transaction_ids: [], warnings: ['ROI metric is missing'] },
}
assert.equal(CashFlowAnalyticsOutputSchema.parse(output).summary.net_cash_flow_minor, -125_000_00)
assert.equal(CashFlowAnalyticsOutputSchema.safeParse({ ...output, summary: { ...output.summary, net_cash_flow_minor: 1 } }).success, false)
assert.equal(CashFlowAnalyticsOutputSchema.safeParse({ ...output, recommendations: [{ ...output.recommendations[0], requires_human_approval: false }] }).success, false)
assert.equal(CashFlowAnalyticsOutputSchema.safeParse({ ...output, impact_assessments: [{ ...output.impact_assessments[0], evidence: [] }] }).success, false)

console.log('[OK] Finance cash-flow contracts: transactions, provenance, reconciliation, impact and approval gates')
