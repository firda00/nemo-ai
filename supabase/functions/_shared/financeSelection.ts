import { z } from 'zod'
import { CashFlowAnalyticsRequestSchema, type CashFlowAnalyticsRequest, type FinanceTransaction } from './financeCashFlow.ts'
import { FinanceInstantSchema } from './financeTime.ts'

export const FinanceSelectionSchema = z.object({
  date_basis: z.literal('occurred_at'), interval: z.literal('[from,to)'),
  input_count: z.number().int().min(1).max(10_000), included_count: z.number().int().min(0).max(10_000),
  outside_period_count: z.number().int().min(0).max(10_000),
  pending_in_period_count: z.number().int().min(0).max(10_000), reversed_in_period_count: z.number().int().min(0).max(10_000),
  audit: z.array(z.object({ transaction_id: z.string().min(1).max(128), occurred_at: FinanceInstantSchema, decision: z.enum(['included', 'outside_period', 'pending', 'reversed']) }).strict()).max(10_000),
}).strict().superRefine((value, context) => {
  if (value.input_count !== value.included_count + value.outside_period_count + value.pending_in_period_count + value.reversed_in_period_count || value.audit.length !== value.input_count) context.addIssue({ code: z.ZodIssueCode.custom, message: 'selection counts do not reconcile' })
  if (new Set(value.audit.map(row => row.transaction_id)).size !== value.audit.length ||
      value.audit.filter(row => row.decision === 'included').length !== value.included_count || value.audit.filter(row => row.decision === 'outside_period').length !== value.outside_period_count ||
      value.audit.filter(row => row.decision === 'pending').length !== value.pending_in_period_count || value.audit.filter(row => row.decision === 'reversed').length !== value.reversed_in_period_count) context.addIssue({ code: z.ZodIssueCode.custom, message: 'selection audit does not reconcile' })
})
export type FinanceSelection = z.infer<typeof FinanceSelectionSchema>

export function selectFinanceTransactions(input: CashFlowAnalyticsRequest) {
  const request = CashFlowAnalyticsRequestSchema.parse(input)
  const from = Date.parse(request.period.from), to = Date.parse(request.period.to)
  const transactions: FinanceTransaction[] = []
  const selection: FinanceSelection = { date_basis: 'occurred_at', interval: '[from,to)', input_count: request.transactions.length, included_count: 0, outside_period_count: 0, pending_in_period_count: 0, reversed_in_period_count: 0, audit: [] }
  for (const transaction of request.transactions) {
    const at = Date.parse(transaction.occurred_at)
    let decision: FinanceSelection['audit'][number]['decision']
    if (at < from || at >= to) { decision = 'outside_period'; selection.outside_period_count++ }
    else if (transaction.status === 'pending') { decision = 'pending'; selection.pending_in_period_count++ }
    else if (transaction.status === 'reversed') { decision = 'reversed'; selection.reversed_in_period_count++ }
    else { decision = 'included'; transactions.push(transaction); selection.included_count++ }
    selection.audit.push({ transaction_id: transaction.transaction_id, occurred_at: transaction.occurred_at, decision })
  }
  return { transactions, selection }
}

// The narrative sees a bounded subset, and can cite ONLY these exact supplied facts.
export function financeNarrativeTransactions(request: CashFlowAnalyticsRequest): FinanceTransaction[] {
  return selectFinanceTransactions(request).transactions.filter(transaction => transaction.evidence.length > 0).slice(0, 250)
}
