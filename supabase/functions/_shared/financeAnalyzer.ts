import {
  CashFlowAnalyticsOutputSchema,
  CashFlowAnalyticsRequestSchema,
  FinanceNarrativeSchema,
  type CashFlowAnalyticsOutput,
  type CashFlowAnalyticsRequest,
} from './financeCashFlow.ts'
import { selectFinanceTransactions, financeNarrativeTransactions } from './financeSelection.ts'
import { financeSafeSum } from './financeAmounts.ts'

const FINDING_PROPERTIES = {
  title: { type: 'string', minLength: 1, maxLength: 240 },
  explanation: { type: 'string', minLength: 1, maxLength: 2000 },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  evidence: { type: 'array', minItems: 1, maxItems: 20, items: { $ref: '#/$defs/evidence' } },
} as const
const FINDING_REQUIRED = ['title', 'explanation', 'confidence', 'evidence'] as const

export const FINANCE_NARRATIVE_JSON_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['impact_assessments', 'inefficiencies', 'recommendations'],
  properties: {
    impact_assessments: { type: 'array', maxItems: 200, items: { $ref: '#/$defs/impact' } },
    inefficiencies: { type: 'array', maxItems: 200, items: { $ref: '#/$defs/inefficiency' } },
    recommendations: { type: 'array', maxItems: 100, items: { $ref: '#/$defs/recommendation' } },
  },
  $defs: {
    locator: {
      type: 'object', additionalProperties: false, minProperties: 1,
      properties: {
        page: { type: 'integer', minimum: 1 }, sheet: { type: 'string', minLength: 1, maxLength: 120 },
        row: { type: 'integer', minimum: 1 }, timestamp_seconds: { type: 'number', minimum: 0 },
        transaction_reference: { type: 'string', minLength: 1, maxLength: 200 },
      },
    },
    evidence: {
      type: 'object', additionalProperties: false, required: ['source_id', 'source_kind', 'locator'],
      properties: {
        source_id: { type: 'string' },
        source_kind: { enum: ['bank_api', 'bank_statement', 'csv', 'xlsx', 'pdf', 'ocr_document', 'audio', 'video', 'manual', 'accounting_api'] },
        locator: { $ref: '#/$defs/locator' }, excerpt: { type: 'string', minLength: 1, maxLength: 1000 },
        content_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
    metric_change: {
      type: 'object', additionalProperties: false, required: ['metric_id', 'before', 'after', 'delta', 'unit'],
      properties: {
        metric_id: { type: 'string' }, before: { type: ['number', 'null'] }, after: { type: ['number', 'null'] },
        delta: { type: ['number', 'null'] }, unit: { type: 'string', minLength: 1, maxLength: 40 },
      },
    },
    impact: {
      type: 'object', additionalProperties: false,
      required: [...FINDING_REQUIRED, 'category_id', 'spend_minor', 'impact_status', 'roi_ratio', 'attribution_quality', 'metric_changes'],
      properties: {
        ...FINDING_PROPERTIES,
        initiative_id: { type: 'string' }, category_id: { type: 'string' }, spend_minor: { type: 'integer', minimum: 0 },
        impact_status: { enum: ['positive', 'neutral', 'negative', 'unknown'] }, roi_ratio: { type: ['number', 'null'] },
        attribution_quality: { enum: ['measured', 'estimated', 'insufficient_data'] },
        metric_changes: { type: 'array', maxItems: 50, items: { $ref: '#/$defs/metric_change' } },
      },
    },
    inefficiency: {
      type: 'object', additionalProperties: false,
      required: [...FINDING_REQUIRED, 'severity', 'affected_transaction_ids', 'avoidable_amount_minor', 'reason_code'],
      properties: {
        ...FINDING_PROPERTIES,
        severity: { enum: ['low', 'medium', 'high', 'critical'] }, affected_transaction_ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string' } },
        avoidable_amount_minor: { type: ['integer', 'null'], minimum: 0 },
        reason_code: { enum: ['duplicate', 'unused_subscription', 'low_roi', 'price_increase', 'budget_overrun', 'unclassified', 'other'] },
      },
    },
    recommendation: {
      type: 'object', additionalProperties: false,
      required: [...FINDING_REQUIRED, 'action', 'estimated_saving_minor', 'owner_role', 'priority', 'requires_human_approval'],
      properties: {
        ...FINDING_PROPERTIES,
        action: { enum: ['continue', 'investigate', 'reduce', 'renegotiate', 'pause', 'cancel'] },
        estimated_saving_minor: { type: ['integer', 'null'], minimum: 0 }, owner_role: { type: 'string', minLength: 1, maxLength: 120 },
        priority: { enum: ['low', 'medium', 'high'] }, requires_human_approval: { const: true },
      },
    },
  },
} as const

export function calculateCashFlow(request: CashFlowAnalyticsRequest) {
  const { transactions, selection } = selectFinanceTransactions(request)
  const inflow = financeSafeSum(transactions.filter(t => t.direction === 'inflow').map(t => t.amount_minor))
  const outflow = financeSafeSum(transactions.filter(t => t.direction === 'outflow').map(t => t.amount_minor))
  const transfers = financeSafeSum(transactions.filter(t => t.direction === 'transfer').map(t => t.amount_minor))
  const categories = new Map<string, { category_id: string; category_name: string; direction: 'inflow' | 'outflow'; amount_minor: number; transaction_count: number }>()
  for (const transaction of transactions) {
    if (transaction.direction === 'transfer') continue
    const categoryId = transaction.category?.id ?? 'uncategorized'
    const key = `${transaction.direction}:${categoryId}`
    const existing = categories.get(key) ?? {
      category_id: categoryId, category_name: transaction.category?.name ?? 'Uncategorized',
      direction: transaction.direction, amount_minor: 0, transaction_count: 0,
    }
    existing.amount_minor = financeSafeSum([existing.amount_minor, transaction.amount_minor])
    existing.transaction_count++
    categories.set(key, existing)
  }
  const net = financeSafeSum([inflow, -outflow])
  const category_breakdown = [...categories.values()].map((category) => ({
    ...category,
    share_of_direction: category.amount_minor / Math.max(1, category.direction === 'inflow' ? inflow : outflow),
  })).sort((a, b) => b.amount_minor - a.amount_minor)
  const uncategorized = transactions.filter((transaction) => transaction.direction !== 'transfer' && !transaction.category).map((transaction) => transaction.transaction_id)
  const missingEvidence = transactions.filter((transaction) => transaction.evidence.length === 0).map((transaction) => transaction.transaction_id)
  const pendingCount = selection.pending_in_period_count
  const totalQualityChecks = Math.max(1, transactions.length * 2)
  return {
    summary: {
      opening_balance_minor: request.opening_balance_minor,
      inflow_minor: inflow,
      outflow_minor: outflow,
      net_cash_flow_minor: net,
      closing_balance_minor: financeSafeSum([request.opening_balance_minor, net]),
      transfer_volume_minor: transfers,
    },
    category_breakdown,
    data_quality: {
      completeness_score: transactions.length ? Math.max(0, 1 - ((uncategorized.length + missingEvidence.length) / totalQualityChecks)) : 0,
      uncategorized_transaction_ids: uncategorized,
      missing_evidence_transaction_ids: missingEvidence,
      warnings: [
        'Source coverage for the period is not verified; opening balance is user supplied at period start',
        ...(selection.outside_period_count ? [`${selection.outside_period_count} transaction(s) outside [from,to) excluded by occurred_at`] : []),
        ...(selection.reversed_in_period_count ? [`${selection.reversed_in_period_count} reversed transaction(s) in the period excluded`] : []),
        ...(pendingCount ? [`${pendingCount} pending transaction(s) excluded from cash-flow totals`] : []),
        ...(!transactions.length ? ['No posted transactions in the selected period'] : []),
        ...(transactions.filter(t => t.evidence.length).length > 250 ? ['Narrative evidence is limited to the first 250 eligible transactions; totals cover all selected transactions'] : []),
        ...(missingEvidence.length ? ['Transactions without evidence cannot support impact or ROI claims'] : []),
      ],
    },
  }
}

function evidenceKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(evidenceKey).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => `${JSON.stringify(key)}:${evidenceKey(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export function validateFinanceNarrative(value: unknown, request: CashFlowAnalyticsRequest) {
  const parsed = FinanceNarrativeSchema.safeParse(value)
  if (!parsed.success) return { narrative: null, errors: parsed.error.issues.slice(0, 12).map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
  const selected = financeNarrativeTransactions(request)
  const expenseTransactions = selected.filter(transaction => transaction.direction === 'outflow')
  const transactionIds = new Set(expenseTransactions.map((transaction) => transaction.transaction_id))
  const transactionAmounts = new Map(expenseTransactions.map((transaction) => [transaction.transaction_id, transaction.amount_minor]))
  const allowedEvidence = new Set(selected.flatMap((transaction) => transaction.evidence.map(evidenceKey)))
  const citedExpenses = (evidence: typeof selected[number]['evidence']) => {
    const keys = new Set(evidence.map(evidenceKey))
    return expenseTransactions.filter(transaction => transaction.evidence.some(ref => keys.has(evidenceKey(ref))))
  }
  const errors: string[] = []
  const findings = [...parsed.data.impact_assessments, ...parsed.data.inefficiencies, ...parsed.data.recommendations]
  findings.forEach((finding, index) => finding.evidence.forEach((evidence) => {
    if (!allowedEvidence.has(evidenceKey(evidence))) errors.push(`finding ${index} cites evidence not present in the request`)
  }))
  parsed.data.inefficiencies.forEach((finding) => finding.affected_transaction_ids.forEach((id) => {
    if (!transactionIds.has(id)) errors.push(`unknown affected transaction: ${id}`)
  }))
  parsed.data.inefficiencies.forEach((finding) => {
    const citedIds = new Set(citedExpenses(finding.evidence).map(transaction => transaction.transaction_id))
    if (finding.affected_transaction_ids.some(id => !citedIds.has(id))) errors.push('each affected transaction must have evidence cited by this finding')
    if (new Set(finding.affected_transaction_ids).size !== finding.affected_transaction_ids.length) errors.push('duplicate affected transaction id')
    const affectedTotal = financeSafeSum([...new Set(finding.affected_transaction_ids)].map(id => transactionAmounts.get(id) ?? 0))
    if (finding.avoidable_amount_minor != null && finding.avoidable_amount_minor > affectedTotal) errors.push('avoidable amount exceeds affected transaction total')
  })
  parsed.data.impact_assessments.forEach((impact) => {
    const cited = citedExpenses(impact.evidence).filter(transaction => transaction.category?.id === impact.category_id)
    if (!cited.length || impact.spend_minor > financeSafeSum(cited.map(transaction => transaction.amount_minor))) errors.push(`impact spend exceeds cited category spend: ${impact.category_id}`)
    // Transactions and objective targets do not establish before/after outcomes
    // or causal attribution. A typed, dated outcome source is not supported yet.
    if (impact.attribution_quality !== 'insufficient_data' || impact.roi_ratio !== null || impact.impact_status !== 'unknown' || impact.metric_changes.length) errors.push('verified outcome evidence is unavailable: use unknown impact, insufficient_data, null ROI and no metric changes')
  })
  parsed.data.recommendations.forEach(finding => {
    if (finding.estimated_saving_minor != null && finding.estimated_saving_minor > financeSafeSum(citedExpenses(finding.evidence).map(transaction => transaction.amount_minor))) errors.push('estimated saving exceeds cited expenses')
  })
  return { narrative: errors.length ? null : parsed.data, errors }
}

export function buildFinanceAnalysisPrompt(request: CashFlowAnalyticsRequest): string {
  const deterministic = calculateCashFlow(request)
  const supported = financeNarrativeTransactions(request)
  const evidenceFacts = supported.map((transaction) => ({
    transaction_id: transaction.transaction_id,
    occurred_at: transaction.occurred_at,
    direction: transaction.direction,
    amount_minor: transaction.amount_minor,
    currency: transaction.currency,
    category: transaction.direction === 'transfer' ? null : transaction.category ?? null,
    impact_context: transaction.direction === 'transfer' ? null : transaction.impact_context ?? null,
    evidence: transaction.evidence,
  }))
  return [
    'Analyze cash-flow impact using only the deterministic aggregates and evidence facts below.',
    'Do not recalculate totals. Do not infer ROI, savings, duplicates, subscription usage or outcomes without cited evidence.',
    'Copy evidence references exactly. If attribution is missing, use impact_status="unknown", attribution_quality="insufficient_data", roi_ratio=null.',
    'This input does not contain verified dated before/after outcome evidence. All impact assessments must use impact_status="unknown", attribution_quality="insufficient_data", roi_ratio=null and metric_changes=[]. Targets or actual objective values alone do not prove causal impact.',
    'Recommendations are advisory and requires_human_approval must always be true.',
    `Period: ${JSON.stringify(request.period)}; occurred_at >= from and < to; posted only. Opening balance is the user's balance at from.`,
    `Deterministic aggregates: ${JSON.stringify(deterministic)}`,
    `Business objectives: ${JSON.stringify(request.business_objectives)}`,
    `Evidence facts: ${JSON.stringify(evidenceFacts)}`,
  ].join('\n')
}

export function assembleCashFlowAnalysis(
  request: CashFlowAnalyticsRequest,
  narrative: NonNullable<ReturnType<typeof validateFinanceNarrative>['narrative']>,
): CashFlowAnalyticsOutput {
  const deterministic = calculateCashFlow(request)
  return CashFlowAnalyticsOutputSchema.parse({
    period: request.period,
    currency: request.base_currency,
    ...deterministic,
    ...narrative,
  })
}

export function parseCashFlowRequest(value: unknown): CashFlowAnalyticsRequest {
  return CashFlowAnalyticsRequestSchema.parse(value)
}
