import { z } from 'zod'
import { FinanceEvidenceRefSchema } from './financeCashFlow.ts'

export const BusinessOrderTypeSchema = z.enum([
  'vacation',
  'business_trip',
  'inventory_writeoff',
  'bonus',
  'hiring',
  'termination',
  'procurement',
  'other',
])

export const BusinessOrderDraftRequestSchema = z.object({
  workspace_id: z.string().uuid(),
  order_type: BusinessOrderTypeSchema,
  locale: z.enum(['uz', 'ru', 'en']),
  effective_date: z.string().date(),
  organization: z.object({
    legal_name: z.string().trim().min(1).max(300),
    registration_number: z.string().trim().min(1).max(100).optional(),
    address: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  subject: z.object({
    employee_id: z.string().trim().min(1).max(128).optional(),
    employee_name: z.string().trim().min(1).max(240).optional(),
    inventory_item_ids: z.array(z.string().trim().min(1).max(128)).max(500).default([]),
    counterparty_id: z.string().trim().min(1).max(128).optional(),
  }).strict(),
  facts: z.record(z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()])),
  related_transaction_ids: z.array(z.string().trim().min(1).max(128)).max(500).default([]),
  evidence: z.array(FinanceEvidenceRefSchema).min(1).max(100),
  requested_signatories: z.array(z.object({
    role: z.string().trim().min(1).max(120),
    person_name: z.string().trim().min(1).max(240).optional(),
  }).strict()).min(1).max(20),
}).strict()

export const BusinessOrderDraftSchema = z.object({
  draft_id: z.string().uuid(),
  order_type: BusinessOrderTypeSchema,
  locale: z.enum(['uz', 'ru', 'en']),
  title: z.string().trim().min(1).max(300),
  legal_basis: z.array(z.object({
    text: z.string().trim().min(1).max(1000),
    evidence: z.array(FinanceEvidenceRefSchema).min(1).max(20),
  }).strict()).max(30),
  clauses: z.array(z.object({
    number: z.number().int().positive(),
    text: z.string().trim().min(1).max(3000),
    responsible_role: z.string().trim().min(1).max(120).optional(),
    deadline: z.string().date().optional(),
  }).strict()).min(1).max(100),
  signatories: z.array(z.object({
    role: z.string().trim().min(1).max(120),
    person_name: z.string().trim().min(1).max(240).optional(),
    signature_status: z.literal('pending'),
  }).strict()).min(1).max(20),
  attachments: z.array(z.object({
    name: z.string().trim().min(1).max(240),
    source_id: z.string().trim().min(1).max(128),
  }).strict()).max(100),
  missing_required_fields: z.array(z.string().trim().min(1).max(240)).max(100),
  status: z.literal('draft_requires_review'),
  requires_human_approval: z.literal(true),
  generated_at: z.string().datetime({ offset: true }),
}).strict().superRefine((draft, context) => {
  draft.clauses.forEach((clause, index) => {
    if (clause.number !== index + 1) context.addIssue({ code: z.ZodIssueCode.custom, path: ['clauses', index, 'number'], message: 'clause numbers must be sequential' })
  })
})

export interface HrOrderGenerator {
  generateDraft(
    request: z.infer<typeof BusinessOrderDraftRequestSchema>,
  ): Promise<z.infer<typeof BusinessOrderDraftSchema>>
}

export function validateOrderDraftAgainstRequest(
  value: unknown,
  request: z.infer<typeof BusinessOrderDraftRequestSchema>,
) {
  const parsed = BusinessOrderDraftSchema.safeParse(value)
  if (!parsed.success) return { draft: null, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) }
  const key = (evidence: z.infer<typeof FinanceEvidenceRefSchema>) => `${evidence.source_id}:${evidence.source_kind}:${JSON.stringify(evidence.locator, Object.keys(evidence.locator).sort())}`
  const allowedEvidence = new Set(request.evidence.map(key))
  const errors: string[] = []
  parsed.data.legal_basis.forEach((basis) => basis.evidence.forEach((evidence) => {
    if (!allowedEvidence.has(key(evidence))) errors.push('draft cites evidence not supplied in the request')
  }))
  return { draft: errors.length ? null : parsed.data, errors }
}

export type BusinessOrderDraftRequest = z.infer<typeof BusinessOrderDraftRequestSchema>
export type BusinessOrderDraft = z.infer<typeof BusinessOrderDraftSchema>
