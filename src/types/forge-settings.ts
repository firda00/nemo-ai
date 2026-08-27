import { z } from 'zod'

export const ForgeConnectorIdSchema = z.enum([
  'amocrm',
  'telegram',
  'uzum',
  'forge-runtime',
  'ffmpeg-worker',
  'whisper-worker',
])

export const ForgeSecretProviderSchema = z.enum(['amocrm', 'telegram', 'uzum'])

/**
 * Write-only input. This type must never be reused as a status or audit response.
 */
export const ForgeIntegrationSecretInputSchema = z.object({
  provider: ForgeSecretProviderSchema,
  secret: z.string().min(16).max(4_096),
  subdomain: z.string().trim().min(2).max(128)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
}).strict().superRefine((input, context) => {
  if (input.provider === 'amocrm' && !input.subdomain) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['subdomain'], message: 'amoCRM subdomain is required' })
  }
  if (input.provider !== 'amocrm' && input.subdomain !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['subdomain'], message: 'subdomain is only valid for amoCRM' })
  }
  if (/\s/.test(input.secret)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['secret'], message: 'secret must not contain whitespace' })
  }
})

export const ForgeSecretRotationResultSchema = z.object({
  provider: ForgeSecretProviderSchema,
  rotatedAt: z.string().datetime({ offset: true }),
  previousValidUntil: z.string().datetime({ offset: true }).nullable(),
  shownOnce: z.literal(true),
  secret: z.string().min(16).max(4_096).optional(),
  webhookUrl: z.string().url().optional(),
}).strict().superRefine((result, context) => {
  if (!result.secret && !result.webhookUrl) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'one-time secret material is missing' })
  }
})

export const ConnectorHealthSchema = z.object({
  connectorId: ForgeConnectorIdSchema,
  label: z.string().min(1).max(120),
  status: z.enum(['healthy', 'degraded', 'unconfigured', 'offline', 'unknown']),
  latencyMs: z.number().int().nonnegative().max(120_000).nullable(),
  activeInboxJobs: z.number().int().nonnegative().max(1_000_000).nullable(),
  checkedAt: z.string().datetime({ offset: true }),
  message: z.string().max(240).optional(),
}).strict()

export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  action: z.enum([
    'secret.rotated',
    'secret.revoked',
    'worker.config.updated',
    'governance.updated',
    'diagnostics.exported',
  ]),
  target: z.string().min(1).max(160),
  outcome: z.enum(['success', 'denied', 'failed']),
  occurredAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.unknown()).default({}),
}).strict().superRefine((entry, context) => {
  const serialized = JSON.stringify(entry.metadata)
  if (new TextEncoder().encode(serialized).byteLength > 16_384) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata'], message: 'audit metadata exceeds 16 KiB' })
  }
  if (/secret|token|password|authorization|api[_-]?key/i.test(serialized)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['metadata'], message: 'audit metadata must not contain secret-like fields' })
  }
})

const AbsoluteBinaryPathSchema = z.string().trim().min(1).max(512)
  .refine((value) => /^(?:[A-Za-z]:[\\/]|\/)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))/.test(value), {
    message: 'an absolute path without traversal is required',
  })
  .refine((value) => !value.includes('\0'), { message: 'NUL bytes are forbidden' })

export const FfmpegBinaryPathSchema = AbsoluteBinaryPathSchema.refine(
  (value) => /(?:^|[\\/])ffmpeg(?:\.exe)?$/i.test(value),
  'path must point to ffmpeg or ffmpeg.exe',
)

export const WhisperBinaryPathSchema = AbsoluteBinaryPathSchema.refine(
  (value) => /(?:^|[\\/])(?:whisper-cli|whisper|main)(?:\.exe)?$/i.test(value),
  'path must point to whisper-cli, whisper, or main',
)

export const ForgeWorkerConfigSchema = z.object({
  ffmpegPath: FfmpegBinaryPathSchema,
  whisperPath: WhisperBinaryPathSchema,
  maxConcurrentWorkers: z.number().int().min(1).max(32),
  defaultBudgetCapUsd: z.number().finite().min(0.01).max(100_000),
  transcriptionModel: z.enum(['tiny', 'base', 'small', 'medium']),
  videoCodec: z.enum(['h264', 'h265', 'vp9']),
}).strict()

export const ForgeGovernanceConfigSchema = z.object({
  defaultBudgetCapUsd: z.number().finite().min(0.01).max(100_000),
  hardProjectCapUsd: z.number().finite().min(0.01).max(1_000_000),
  contentRightsPolicy: z.enum(['fail_closed', 'strict_cc0']),
  requireApprovalBeforePublish: z.literal(true),
}).strict().superRefine((config, context) => {
  if (config.defaultBudgetCapUsd > config.hardProjectCapUsd) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultBudgetCapUsd'], message: 'default cap exceeds hard cap' })
  }
})

export const ForgeSettingsSchema = z.object({
  schemaVersion: z.literal('1.0'),
  worker: ForgeWorkerConfigSchema,
  governance: ForgeGovernanceConfigSchema,
}).strict()

export type ForgeConnectorId = z.infer<typeof ForgeConnectorIdSchema>
export type ForgeIntegrationSecretInput = z.infer<typeof ForgeIntegrationSecretInputSchema>
export type ForgeSecretRotationResult = z.infer<typeof ForgeSecretRotationResultSchema>
export type ConnectorHealth = z.infer<typeof ConnectorHealthSchema>
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>
export type ForgeWorkerConfig = z.infer<typeof ForgeWorkerConfigSchema>
export type ForgeGovernanceConfig = z.infer<typeof ForgeGovernanceConfigSchema>
export type ForgeSettings = z.infer<typeof ForgeSettingsSchema>

