import { z } from 'zod'

export const BusinessIntentSourceSchema = z.enum([
  'web_text',
  'web_voice',
  'telegram_text',
  'telegram_voice',
  'phone_call',
  'scheduled_briefing',
])

export const BusinessIntentGoalSchema = z.enum([
  'launch_campaign',
  'qualify_lead',
  'create_content',
  'competitor_audit',
  'daily_briefing',
  'morning_brief',
  'generic_business_task',
])

export const BusinessIntentMetadataSchema = z.object({
  userId: z.string().min(1).max(160).optional(),
  workspaceId: z.string().uuid().optional(),
  telegram: z.object({
    chatId: z.string().regex(/^-?\d{1,20}$/),
    messageId: z.number().int().positive(),
    messageThreadId: z.number().int().positive().optional(),
    channelId: z.string().uuid().optional(),
  }).strict().optional(),
}).strict()

export const BusinessIntentSchema = z.object({
  schemaVersion: z.literal('1.0'),
  intentId: z.string().uuid(),
  source: BusinessIntentSourceSchema,
  actor: z.enum(['owner', 'customer']),
  locale: z.enum(['ru', 'uz', 'en', 'mixed']),
  goal: BusinessIntentGoalSchema,
  rawText: z.string().min(3).max(4_000),
  channels: z.array(z.enum(['telegram', 'instagram', 'youtube', 'whatsapp', 'crm', 'phone'])).max(6),
  extractedFacts: z.object({
    discountPercent: z.number().min(0).max(100).optional(),
    competitorUrl: z.string().url().optional(),
    requestedTime: z.string().max(120).optional(),
  }).strict(),
  confidence: z.number().min(0).max(1),
  clarificationRequired: z.boolean(),
  clarificationQuestions: z.array(z.string().min(3).max(240)).max(3),
  approvalRequired: z.boolean(),
  metadata: BusinessIntentMetadataSchema.default({}),
  safety: z.object({
    evidenceRequired: z.literal(true),
    externalEffectsRequireApproval: z.literal(true),
    budgetCapUsd: z.number().finite().positive().max(10_000),
  }).strict(),
  createdAt: z.string().datetime({ offset: true }),
}).strict()

export type BusinessIntent = z.infer<typeof BusinessIntentSchema>
export type BusinessIntentSource = z.infer<typeof BusinessIntentSourceSchema>
export type BusinessIntentGoal = z.infer<typeof BusinessIntentGoalSchema>
export type BusinessIntentMetadata = z.infer<typeof BusinessIntentMetadataSchema>
