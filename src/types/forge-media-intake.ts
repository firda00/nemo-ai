import { z } from 'zod'

const UUID = z.string().uuid()
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters')
const HttpsUrlSchema = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required')
const TenantUploadPathSchema = z.string().max(512).regex(
  /^tenants\/[0-9a-f-]{36}\/uploads\/[A-Za-z0-9/_-]+\.(?:mp4|webm)$/i,
  'clip must reference a tenant-scoped staged upload',
)
const ArtifactPathSchema = z.string().max(512).regex(
  /^tenants\/[0-9a-f-]{36}\/artifacts\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]+\.(?:mp4|webm)$/i,
)

function decodedUrlPath(raw: string): string | null {
  try {
    return decodeURIComponent(new URL(raw).pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
}

export const RightsLicenseTypeSchema = z.enum([
  'owned',
  'commissioned',
  'cc0',
  'licensed_stock',
  'provider_generated',
])

/**
 * A claim of ownership is not enough: every asset needs immutable identity and
 * a durable proof reference. The proof itself stays in tenant storage, not in
 * prompts, logs, or render subprocess environments.
 */
export const AssetRightsManifestSchema = z.object({
  assetId: UUID,
  sha256: Sha256Schema,
  licenseType: RightsLicenseTypeSchema,
  licenseIdentifier: z.string().min(1).max(160),
  owner: z.string().min(1).max(240),
  proofRef: z.string().min(1).max(512),
  sourceUrl: HttpsUrlSchema.optional(),
  verifiedAt: z.string().datetime({ offset: true }),
  commercialAllowed: z.literal(true),
  derivativesAllowed: z.literal(true),
  attributionText: z.string().max(500).optional(),
}).strict().superRefine((manifest, context) => {
  if (manifest.licenseType === 'cc0' && manifest.licenseIdentifier !== 'CC0-1.0') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CC0 assets require the exact CC0-1.0 identifier',
      path: ['licenseIdentifier'],
    })
  }
})

export const IntakeWordTimingSchema = z.object({
  text: z.string().trim().min(1).max(80),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  confidence: z.number().min(0).max(1).optional(),
}).strict().refine((word) => word.endMs > word.startMs, {
  message: 'word end must follow word start',
  path: ['endMs'],
})

export const SpeechSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  text: z.string().trim().min(1).max(600),
  words: z.array(IntakeWordTimingSchema).min(1).max(120),
}).strict().superRefine((segment, context) => {
  if (segment.endMs <= segment.startMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'segment end must follow start', path: ['endMs'] })
  }
  let previousEnd = segment.startMs
  for (const [index, word] of segment.words.entries()) {
    if (word.startMs < segment.startMs || word.endMs > segment.endMs || word.startMs < previousEnd) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'word timings must be ordered inside the segment', path: ['words', index] })
    }
    previousEnd = word.endMs
  }
})

export const VideoClipInputSchema = z.object({
  clipId: UUID,
  stagedPath: TenantUploadPathSchema,
  downloadUrl: HttpsUrlSchema,
  mimeType: z.enum(['video/mp4', 'video/webm']),
  sizeBytes: z.number().int().positive().max(200 * 1024 * 1024),
  sha256: Sha256Schema,
  durationSeconds: z.number().positive().max(120),
  width: z.number().int().min(160).max(3840),
  height: z.number().int().min(160).max(3840),
  fps: z.number().positive().max(60).default(30),
  speechSegments: z.array(SpeechSegmentSchema).max(500).default([]),
  rightsManifest: AssetRightsManifestSchema,
}).strict().superRefine((clip, context) => {
  if (clip.rightsManifest.assetId !== clip.clipId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'rights assetId must match clipId', path: ['rightsManifest', 'assetId'] })
  }
  if (clip.rightsManifest.sha256 !== clip.sha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'rights hash must match clip hash', path: ['rightsManifest', 'sha256'] })
  }
  for (const [index, segment] of clip.speechSegments.entries()) {
    if (segment.endMs > Math.round(clip.durationSeconds * 1_000)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'speech segment exceeds clip duration', path: ['speechSegments', index] })
    }
  }
})

export const MediaIntakePayloadSchema = z.object({
  accountId: UUID,
  projectId: UUID,
  workflowId: UUID,
  executionId: UUID,
  stepId: UUID,
  clips: z.array(VideoClipInputSchema).min(1, 'upload 1 to 5 clips').max(5, 'upload 1 to 5 clips'),
  targetPreset: z.enum(['business_explainer', 'cinematic_short']),
  targetRatio: z.enum(['9:16', '16:9', '1:1']),
  maxDurationSeconds: z.number().positive().max(120).default(30),
  language: z.enum(['uz', 'ru', 'en']).default('ru'),
  subtitleStyle: z.enum(['clean_minimal', 'dynamic_karaoke']).default('dynamic_karaoke'),
  brand: z.object({
    colors: z.array(z.string().regex(/^#[0-9A-Fa-f]{6}$/)).min(1).max(4).default(['#00F0FF', '#FFFFFF']),
    fontFamily: z.enum(['Arial', 'Inter', 'Montserrat', 'Roboto', 'Noto Sans']).default('Arial'),
  }).strict().default({ colors: ['#00F0FF', '#FFFFFF'], fontFamily: 'Arial' }),
  output: z.object({
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:mp4|webm)$/i),
    storagePath: ArtifactPathSchema,
    uploadUrl: HttpsUrlSchema,
    expiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
}).strict().superRefine((payload, context) => {
  const clipIds = new Set(payload.clips.map((clip) => clip.clipId))
  if (clipIds.size !== payload.clips.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'clip IDs must be unique', path: ['clips'] })
  }
  const inputPrefix = `tenants/${payload.accountId}/uploads/`
  for (const [index, clip] of payload.clips.entries()) {
    if (!clip.stagedPath.startsWith(inputPrefix)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'clip belongs to another tenant', path: ['clips', index, 'stagedPath'] })
    }
    const downloadPath = decodedUrlPath(clip.downloadUrl)
    if (!downloadPath?.endsWith(clip.stagedPath)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'download capability is not bound to the staged clip', path: ['clips', index, 'downloadUrl'] })
    }
  }
  if (payload.clips.reduce((total, clip) => total + clip.sizeBytes, 0) > 512 * 1024 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'aggregate input exceeds 512 MiB', path: ['clips'] })
  }
  if (payload.targetPreset === 'cinematic_short' && payload.targetRatio !== '9:16') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'cinematic_short requires 9:16', path: ['targetRatio'] })
  }
  const outputPrefix = `tenants/${payload.accountId}/artifacts/`
  if (!payload.output.storagePath.startsWith(outputPrefix) || !payload.output.storagePath.endsWith(`/${payload.output.name}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'output must be bound to the tenant and output name', path: ['output', 'storagePath'] })
  }
  const uploadPath = decodedUrlPath(payload.output.uploadUrl)
  if (!uploadPath?.endsWith(payload.output.storagePath)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'upload capability is not bound to the output object', path: ['output', 'uploadUrl'] })
  }
})

export type AssetRightsManifest = z.infer<typeof AssetRightsManifestSchema>
export type IntakeWordTiming = z.infer<typeof IntakeWordTimingSchema>
export type SpeechSegment = z.infer<typeof SpeechSegmentSchema>
export type VideoClipInput = z.infer<typeof VideoClipInputSchema>
export type MediaIntakePayload = z.infer<typeof MediaIntakePayloadSchema>
