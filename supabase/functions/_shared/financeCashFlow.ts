import { z } from 'zod'
import { FinanceInstantSchema, FinancePeriodSchema } from './financeTime.ts'

const EntityIdSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const CurrencySchema = z.string().regex(/^[A-Z]{3}$/)
const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
const MinorAmountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const FinanceSourceKindSchema = z.enum([
  'bank_api',
  'bank_statement',
  'csv',
  'xlsx',
  'pdf',
  'ocr_document',
  'audio',
  'video',
  'manual',
  'accounting_api',
])

export const FinanceEvidenceRefSchema = z.object({
  source_id: EntityIdSchema,
  source_kind: FinanceSourceKindSchema,
  locator: z.object({
    page: z.number().int().positive().optional(),
    sheet: z.string().trim().min(1).max(120).optional(),
    row: z.number().int().positive().optional(),
    timestamp_seconds: z.number().finite().nonnegative().optional(),
    transaction_reference: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  excerpt: z.string().trim().min(1).max(1000).optional(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((evidence, context) => {
  if (!Object.values(evidence.locator).some((value) => value !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'evidence locator cannot be empty' })
  }
})

export const FinanceCategorySchema = z.object({
  id: EntityIdSchema,
  name: z.string().trim().min(1).max(160),
  group: z.enum([
    'revenue', 'cost_of_sales', 'payroll', 'marketing', 'infrastructure', 'software_subscription',
    'office', 'tax', 'bank_fee', 'debt', 'capital_expenditure', 'owner_draw', 'other',
  ]),
  parent_id: EntityIdSchema.optional(),
}).strict()

export const FinanceTransactionSourceSchema = z.object({
  source_id: EntityIdSchema,
  source_kind: FinanceSourceKindSchema,
  imported_at: FinanceInstantSchema,
  external_id: z.string().trim().min(1).max(240).optional(),
  source_row: z.number().int().positive().optional(),
  source_page: z.number().int().positive().optional(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()

const TransactionBaseSchema = z.object({
  transaction_id: EntityIdSchema,
  workspace_id: z.string().uuid(),
  occurred_at: FinanceInstantSchema,
  posted_at: FinanceInstantSchema.optional(),
  amount_minor: MinorAmountSchema.positive(),
  currency: CurrencySchema,
  status: z.enum(['pending', 'posted', 'reversed']),
  category: FinanceCategorySchema.optional(),
  counterparty_id: EntityIdSchema.optional(),
  counterparty_name: z.string().trim().min(1).max(240).optional(),
  project_id: EntityIdSchema.optional(),
  cost_center_id: EntityIdSchema.optional(),
  payment_method_id: EntityIdSchema.optional(),
  description: z.string().trim().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
  cash_flow_period: MonthSchema,
  recognition_period: MonthSchema.optional(),
  source: FinanceTransactionSourceSchema,
  evidence: z.array(FinanceEvidenceRefSchema).max(20).default([]),
  impact_context: z.object({
    initiative_id: EntityIdSchema.optional(),
    spend_purpose: z.string().trim().min(1).max(500),
    expected_outcome: z.string().trim().min(1).max(1000).optional(),
    metric_ids: z.array(EntityIdSchema).max(20).default([]),
  }).strict().optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
})

const InflowTransactionSchema = TransactionBaseSchema.extend({
  direction: z.literal('inflow'),
  account_id: EntityIdSchema,
}).strict()

const OutflowTransactionSchema = TransactionBaseSchema.extend({
  direction: z.literal('outflow'),
  account_id: EntityIdSchema,
}).strict()

const TransferTransactionSchema = TransactionBaseSchema.omit({ category: true, impact_context: true }).extend({
  direction: z.literal('transfer'),
  from_account_id: EntityIdSchema,
  to_account_id: EntityIdSchema,
}).strict()

export const FinanceTransactionSchema = z.discriminatedUnion('direction', [
  InflowTransactionSchema,
  OutflowTransactionSchema,
  TransferTransactionSchema,
]).superRefine((transaction, context) => {
  if (transaction.direction !== 'transfer') return
  if (transaction.from_account_id === transaction.to_account_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'transfer accounts must differ' })
  }
})

export const CashFlowAnalyticsRequestSchema = z.object({
  workspace_id: z.string().uuid(),
  period: FinancePeriodSchema,
  base_currency: CurrencySchema,
  opening_balance_minor: z.number().int().safe(),
  transactions: z.array(FinanceTransactionSchema).min(1).max(10_000),
  business_objectives: z.array(z.object({
    id: EntityIdSchema,
    name: z.string().trim().min(1).max(200),
    metric_id: EntityIdSchema,
    target_value: z.number().finite(),
    actual_value: z.number().finite().optional(),
    unit: z.string().trim().min(1).max(40),
  }).strict()).max(100).default([]),
}).strict().superRefine((request, context) => {
  if (Date.parse(request.period.from) >= Date.parse(request.period.to)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'period.from must be before period.to' })
  }
  const ids = new Set<string>()
  request.transactions.forEach((transaction, index) => {
    if (ids.has(transaction.transaction_id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['transactions', index, 'transaction_id'], message: 'duplicate transaction id' })
    ids.add(transaction.transaction_id)
    if (transaction.workspace_id !== request.workspace_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['transactions', index, 'workspace_id'], message: 'workspace mismatch' })
    }
    if (transaction.currency !== request.base_currency) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['transactions', index, 'currency'], message: 'transaction must be converted to base currency' })
    }
  })
})

export const GroundedFindingBaseSchema = z.object({
  title: z.string().trim().min(1).max(240),
  explanation: z.string().trim().min(1).max(2000),
  confidence: z.number().finite().min(0).max(1),
  evidence: z.array(FinanceEvidenceRefSchema).min(1).max(20),
}).strict()

export const FinanceNarrativeSchema = z.object({
  impact_assessments: z.array(GroundedFindingBaseSchema.extend({
    initiative_id: EntityIdSchema.optional(),
    category_id: EntityIdSchema,
    spend_minor: MinorAmountSchema,
    impact_status: z.enum(['positive', 'neutral', 'negative', 'unknown']),
    roi_ratio: z.number().finite().nullable(),
    attribution_quality: z.enum(['measured', 'estimated', 'insufficient_data']),
    metric_changes: z.array(z.object({
      metric_id: EntityIdSchema,
      before: z.number().finite().nullable(),
      after: z.number().finite().nullable(),
      delta: z.number().finite().nullable(),
      unit: z.string().trim().min(1).max(40),
    }).strict()).max(50),
  }).strict()).max(200),
  inefficiencies: z.array(GroundedFindingBaseSchema.extend({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    affected_transaction_ids: z.array(EntityIdSchema).min(1).max(500),
    avoidable_amount_minor: MinorAmountSchema.nullable(),
    reason_code: z.enum(['duplicate', 'unused_subscription', 'low_roi', 'price_increase', 'budget_overrun', 'unclassified', 'other']),
  }).strict()).max(200),
  recommendations: z.array(GroundedFindingBaseSchema.extend({
    action: z.enum(['continue', 'investigate', 'reduce', 'renegotiate', 'pause', 'cancel']),
    estimated_saving_minor: MinorAmountSchema.nullable(),
    owner_role: z.string().trim().min(1).max(120),
    priority: z.enum(['low', 'medium', 'high']),
    requires_human_approval: z.literal(true),
  }).strict()).max(100),
}).strict()

export const CashFlowAnalyticsOutputSchema = z.object({
  period: FinancePeriodSchema,
  currency: CurrencySchema,
  summary: z.object({
    opening_balance_minor: z.number().int().safe(),
    inflow_minor: MinorAmountSchema,
    outflow_minor: MinorAmountSchema,
    net_cash_flow_minor: z.number().int().safe(),
    closing_balance_minor: z.number().int().safe(),
    transfer_volume_minor: MinorAmountSchema,
  }).strict(),
  category_breakdown: z.array(z.object({
    category_id: EntityIdSchema,
    category_name: z.string().trim().min(1).max(160),
    direction: z.enum(['inflow', 'outflow']),
    amount_minor: MinorAmountSchema,
    share_of_direction: z.number().finite().min(0).max(1),
    transaction_count: z.number().int().nonnegative(),
  }).strict()).max(500),
  impact_assessments: FinanceNarrativeSchema.shape.impact_assessments,
  inefficiencies: FinanceNarrativeSchema.shape.inefficiencies,
  recommendations: FinanceNarrativeSchema.shape.recommendations,
  data_quality: z.object({
    completeness_score: z.number().finite().min(0).max(1),
    uncategorized_transaction_ids: z.array(EntityIdSchema).max(10_000),
    missing_evidence_transaction_ids: z.array(EntityIdSchema).max(10_000),
    warnings: z.array(z.string().trim().min(1).max(500)).max(100),
  }).strict(),
}).strict().superRefine((output, context) => {
  if (output.summary.net_cash_flow_minor !== output.summary.inflow_minor - output.summary.outflow_minor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['summary', 'net_cash_flow_minor'], message: 'net cash flow does not reconcile' })
  }
  if (output.summary.closing_balance_minor !== output.summary.opening_balance_minor + output.summary.net_cash_flow_minor) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['summary', 'closing_balance_minor'], message: 'closing balance does not reconcile' })
  }
})

export type FinanceTransaction = z.infer<typeof FinanceTransactionSchema>
export type CashFlowAnalyticsRequest = z.infer<typeof CashFlowAnalyticsRequestSchema>
export type CashFlowAnalyticsOutput = z.infer<typeof CashFlowAnalyticsOutputSchema>
