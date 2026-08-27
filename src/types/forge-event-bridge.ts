import { z } from 'zod'

export const ForgeEventProviderSchema = z.enum(['amocrm', 'telegram', 'uzum'])

export const ForgeEventTypeSchema = z.enum([
  'crm.lead.created',
  'telegram.command.received',
  'marketplace.order.status_changed',
])

export const ForgeSignatureModeSchema = z.enum(['hmac_sha256', 'telegram_secret_token'])

export const ForgeEventHeadersSchema = z.object({
  triggerId: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  signature: z.string().min(16).max(512),
}).strict()

const JsonObjectSchema = z.record(z.unknown()).superRefine((value, context) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength
  if (bytes > 65_536) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'payload exceeds 64 KiB' })
  }
})

export const ForgeInboundEventSchema = z.object({
  externalEventId: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  eventType: ForgeEventTypeSchema,
  occurredAt: z.string().datetime({ offset: true }),
  payload: JsonObjectSchema,
}).strict()

export const ForgeEventTriggerSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  projectId: z.string().uuid(),
  provider: ForgeEventProviderSchema,
  eventType: ForgeEventTypeSchema,
  signatureMode: ForgeSignatureModeSchema,
  secretRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  taskTemplate: z.string().min(3).max(4_096),
  estimatedUnits: z.number().int().positive().max(1_000_000_000),
  maxEventsPerMinute: z.number().int().min(1).max(10_000).default(60),
  executionMode: z.enum(['shadow', 'live']).default('shadow'),
  active: z.boolean(),
}).strict().superRefine((trigger, context) => {
  const expected = trigger.provider === 'amocrm'
    ? 'crm.lead.created'
    : trigger.provider === 'telegram'
      ? 'telegram.command.received'
      : 'marketplace.order.status_changed'
  if (trigger.eventType !== expected) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eventType'],
      message: 'event type is not allowed for provider',
    })
  }
})

export const ForgeEventEnqueueInputSchema = z.object({
  accountId: z.string().uuid(),
  triggerId: z.string().uuid(),
  projectId: z.string().uuid(),
  provider: ForgeEventProviderSchema,
  eventType: ForgeEventTypeSchema,
  externalEventId: z.string().min(1).max(256),
  occurredAt: z.string().datetime({ offset: true }),
  payload: JsonObjectSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  executionMode: z.enum(['shadow', 'live']),
  estimatedUnits: z.number().int().positive(),
  plan: z.record(z.unknown()),
}).strict()

export const ForgeEventEnqueueResultSchema = z.object({
  status: z.enum(['created', 'duplicate', 'budget_denied', 'rate_limited']),
  inboundEventId: z.string().uuid().optional(),
  workflowId: z.string().uuid().optional(),
  executionId: z.string().uuid().optional(),
  reservationId: z.string().uuid().optional(),
}).strict()

export type ForgeEventProvider = z.infer<typeof ForgeEventProviderSchema>
export type ForgeEventHeaders = z.infer<typeof ForgeEventHeadersSchema>
export type ForgeInboundEvent = z.infer<typeof ForgeInboundEventSchema>
export type ForgeEventTrigger = z.infer<typeof ForgeEventTriggerSchema>
export type ForgeEventEnqueueInput = z.infer<typeof ForgeEventEnqueueInputSchema>
export type ForgeEventEnqueueResult = z.infer<typeof ForgeEventEnqueueResultSchema>
