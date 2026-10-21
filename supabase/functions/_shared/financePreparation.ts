import { CashFlowAnalyticsRequestSchema, CashFlowAnalyticsOutputSchema, type CashFlowAnalyticsRequest, type FinanceTransaction } from './financeCashFlow.ts'
import { ingestFinanceSources, type FinanceAnalyzeApiInput, type FinanceIngestionResult } from './financeIngestion.ts'
import { calculateCashFlow } from './financeAnalyzer.ts'
import { FinanceCalculationError } from './financeAmounts.ts'
import { selectFinanceTransactions, type FinanceSelection } from './financeSelection.ts'

export function prepareFinanceAnalysis(input: FinanceAnalyzeApiInput, accountId: string):
  | { ok: true; request: CashFlowAnalyticsRequest; transactions: FinanceTransaction[]; selection: FinanceSelection; ingestion: FinanceIngestionResult }
  | { ok: false; status: number; code: string; ingestion?: FinanceIngestionResult } {
  if (input.workspace_id !== accountId || input.transactions.some(t => t.workspace_id !== accountId)) return { ok: false, status: 403, code: 'WORKSPACE_FORBIDDEN' }
  const ingestion = ingestFinanceSources(input.sources, accountId)
  // A partial source cannot support a complete period: refuse BEFORE keys/model/billing.
  if (ingestion.rejected.length || ingestion.warnings.length) return { ok: false, status: 400, code: 'INGESTION_INCOMPLETE', ingestion }
  const all = [...input.transactions, ...ingestion.transactions]
  if (new Set(all.map(t => t.transaction_id)).size !== all.length) return { ok: false, status: 400, code: 'DUPLICATE_TRANSACTION_ID' }
  const checked = CashFlowAnalyticsRequestSchema.safeParse({ workspace_id: accountId, period: input.period, base_currency: input.base_currency, opening_balance_minor: input.opening_balance_minor, transactions: all, business_objectives: input.business_objectives })
  if (!checked.success) return { ok: false, status: 400, code: 'NORMALIZATION_FAILED' }
  const request = checked.data
  const { transactions, selection } = selectFinanceTransactions(request)
  if (!transactions.length) return { ok: false, status: 400, code: 'NO_TRANSACTIONS_IN_PERIOD' }
  try {
    // Preflight both numeric exactness and complete output shape before paying for prose.
    const deterministic = calculateCashFlow(request)
    CashFlowAnalyticsOutputSchema.parse({ period: request.period, currency: request.base_currency, ...deterministic, impact_assessments: [], inefficiencies: [], recommendations: [] })
  } catch (error) { return { ok: false, status: 400, code: error instanceof FinanceCalculationError ? error.code : 'REPORT_LIMIT_EXCEEDED' } }
  return { ok: true, request, transactions, selection, ingestion }
}
