import { z } from 'zod'

const MAX_STREAM_BYTES = 64 * 1024
const MAX_JSON_BYTES = 64 * 1024
const SHA256 = /^[a-f0-9]{64}$/
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const STORAGE_PATH = /^tenants\/[0-9a-f-]{36}\/(?:artifacts|vision)\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]{1,160}$/

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function boundedJsonObject(maxBytes = MAX_JSON_BYTES) {
  return z.record(z.unknown()).superRefine((value, context) => {
    if (byteLength(JSON.stringify(value)) > maxBytes) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `JSON exceeds ${maxBytes} bytes` })
    }
  })
}

export const ComputeProfileSchema = z.enum([
  'PROFILE_A_WASI',
  'PROFILE_B_DOCS',
  'PROFILE_C_BROWSER',
  'PROFILE_D_GPU',
])

export const ComputeJobSchema = z.object({
  account_id: z.string().uuid(),
  job_id: z.string().uuid(),
  workflow_id: z.string().uuid(),
  profile: ComputeProfileSchema,
  claim_token: z.string().uuid(),
  lease_epoch: z.number().int().nonnegative(),
  lease_until: z.string().datetime({ offset: true }),
  attempt_count: z.number().int().positive(),
  max_attempts: z.number().int().min(1).max(20),
  input_payload: boundedJsonObject(),
}).strict().refine((job) => job.attempt_count <= job.max_attempts, {
  message: 'attempt_count exceeds max_attempts',
  path: ['attempt_count'],
})

const ArtifactEntrySchema = z.object({
  name: z.string().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/),
  mime_type: z.string().min(3).max(120).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  size_bytes: z.number().int().nonnegative().max(1_073_741_824),
  duration_seconds: z.number().finite().positive().max(3_600).optional(),
  sha256: z.string().regex(SHA256),
  storage_path: z.string().max(512).regex(STORAGE_PATH),
}).strict()

export const ArtifactManifestSchema = z.object({
  job_id: z.string().uuid(),
  status: z.enum(['COMPLETED', 'FAILED']),
  exit_code: z.number().int().min(0).max(255),
  execution_time_ms: z.number().int().nonnegative().max(300_000),
  stdout_sanitized: z.string().superRefine((value, context) => {
    if (byteLength(value) > MAX_STREAM_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'stdout exceeds 64 KiB' })
    }
  }),
  stderr_sanitized: z.string().superRefine((value, context) => {
    if (byteLength(value) > MAX_STREAM_BYTES) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'stderr exceeds 64 KiB' })
    }
  }),
  artifacts: z.array(ArtifactEntrySchema).max(64),
  provenance: z.object({
    engine_version: z.string().min(1).max(128),
    template_hash: z.string().regex(SHA256).optional(),
    seed: z.union([z.number().int(), z.string().max(128)]).optional(),
  }).strict(),
}).strict()

export const VisionEventSchema = z.object({
  event_id: z.string().regex(UUID_V7, 'event_id must be UUIDv7'),
  account_id: z.string().uuid(),
  device_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  timestamp: z.string().datetime({ precision: 3, offset: true }),
  event_type: z.string().min(1).max(120).regex(/^[A-Z][A-Z0-9_]*$/),
  precision_score: z.number().min(0).max(1),
  bounding_box: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict().optional(),
  untrusted_attributes: boundedJsonObject(16 * 1024),
  snapshot_ref: z.string().max(512).regex(STORAGE_PATH).optional(),
}).strict().superRefine((event, context) => {
  if (event.snapshot_ref && (
    !event.snapshot_ref.startsWith(`tenants/${event.account_id}/vision/`)
    || !event.snapshot_ref.toLowerCase().endsWith('.jpg')
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'snapshot_ref must be a tenant-scoped JPEG vision object',
      path: ['snapshot_ref'],
    })
  }
})

export const WasiExecutionInputSchema = z.object({
  source: z.string().min(1).max(48 * 1024),
  parameters: boundedJsonObject(16 * 1024).default({}),
}).strict()

export type ComputeJob = z.infer<typeof ComputeJobSchema>
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>
export type VisionEvent = z.infer<typeof VisionEventSchema>
export type WasiExecutionInput = z.infer<typeof WasiExecutionInputSchema>
