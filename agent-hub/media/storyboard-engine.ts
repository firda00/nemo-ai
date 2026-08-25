import { z } from 'zod'
import { MediaAssetSchema, MediaJobPayloadSchema, type MediaJobPayload } from './ffmpeg-pipeline.ts'

const SceneSchema = z.object({
  asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  duration_seconds: z.number().min(0.1).max(120),
  narration: z.string().max(1_000).optional(),
  overlay: z.string().max(300).optional(),
  transition: z.object({ type: z.enum(['cut', 'fade', 'crossfade']), duration_seconds: z.number().min(0.1).max(3).default(0.5) }).strict().optional(),
  image_overlays: z.array(z.object({ asset_id: z.string().regex(/^[A-Za-z0-9_-]+$/), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(), x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).strict()).max(8).default([]),
  word_timings: z.array(z.object({ text: z.string().min(1).max(80), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive() }).strict()).max(80).optional(),
}).strict()

export const StoryboardScriptSchema = z.object({
  title: z.string().min(1).max(160),
  scenes: z.array(SceneSchema).min(1).max(100),
}).strict().superRefine((script, context) => {
  if (script.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0) > 120) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'storyboard duration exceeds 120 seconds', path: ['scenes'] })
  }
})

export const StoryboardTemplateSchema = z.object({
  account_id: z.string().uuid().transform((value) => value.toLowerCase()),
  output_name: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mp4|webm)$/i),
  upload_url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
  expires_at: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  date_path: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  assets: z.array(MediaAssetSchema).min(1).max(64),
  width: z.number().int().min(160).max(1920).default(1920),
  height: z.number().int().min(160).max(1920).default(1080),
  fps: z.number().int().min(1).max(60).default(30),
  video_bitrate_kbps: z.number().int().min(128).max(12_000).default(4_000),
  max_output_bytes: z.number().int().positive().max(256 * 1024 * 1024).default(256 * 1024 * 1024),
  codec: z.enum(['h264', 'h265', 'vp9']).default('h264'),
  format_preset: z.enum(['LANDSCAPE_16_9', 'VERTICAL_9_16', 'CUSTOM']).default('CUSTOM'),
  voice_asset_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  background_audio_asset_id: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  background_volume: z.number().min(0.02).max(0.8).default(0.18),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
  seconds_per_scene: z.number().min(0.1).max(30).default(5),
}).strict().superRefine((value, context) => {
  if (Math.max(value.width, value.height) > 1920 || Math.min(value.width, value.height) > 1080) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolution exceeds 1080p', path: ['width'] })
  }
})

export type StoryboardScript = z.infer<typeof StoryboardScriptSchema>
export type StoryboardTemplate = z.input<typeof StoryboardTemplateSchema>

function assertSafeAssetUrl(raw: string): void {
  const url = new URL(raw)
  let decodedRaw = raw
  let path = url.pathname
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const nextRaw = decodeURIComponent(decodedRaw)
      const nextPath = decodeURIComponent(path)
      if (nextRaw === decodedRaw && nextPath === path) break
      decodedRaw = nextRaw
      path = nextPath
    }
  } catch {
    throw new Error('STORYBOARD_ASSET_PATH_INVALID')
  }
  // A remaining encoded separator/dot after bounded fixed-point decoding is ambiguous
  // across proxies/storage backends, so reject it rather than risk a second decoder.
  if (/%(?:2e|2f|5c)/i.test(decodedRaw) || /%(?:2e|2f|5c)/i.test(path)
    || decodedRaw.includes('\\') || /(^|\/)\.\.?($|\/)/.test(decodedRaw) || path.includes('\\')
    || path.split('/').some((part) => part === '..' || part === '.') || path.includes('\0')) {
    throw new Error('STORYBOARD_ASSET_PATH_INVALID')
  }
}

function fromText(script: string, template: z.output<typeof StoryboardTemplateSchema>): StoryboardScript {
  const blocks = script.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  if (!blocks.length || blocks.length > template.assets.length) throw new Error('STORYBOARD_SCENE_ASSET_MISMATCH')
  return StoryboardScriptSchema.parse({
    title: blocks[0].slice(0, 160),
    scenes: blocks.map((block, index) => ({
      asset_id: template.assets[index].id,
      duration_seconds: template.seconds_per_scene,
      narration: block.slice(0, 1_000),
      overlay: block.split(/[.!?]/)[0].trim().slice(0, 300) || undefined,
    })),
  })
}

export function createStoryboardManifest(
  rawScript: string | StoryboardScript,
  rawTemplate: StoryboardTemplate,
): MediaJobPayload {
  const template = StoryboardTemplateSchema.parse(rawTemplate)
  for (const asset of template.assets) assertSafeAssetUrl(asset.download_url)
  const script = typeof rawScript === 'string' ? fromText(rawScript, template) : StoryboardScriptSchema.parse(rawScript)
  const assetIds = new Set(template.assets.map((asset) => asset.id))
  for (const scene of script.scenes) if (!assetIds.has(scene.asset_id)) throw new Error('STORYBOARD_ASSET_MISSING')
  for (const scene of script.scenes) for (const overlay of scene.image_overlays) {
    if (!assetIds.has(overlay.asset_id)) throw new Error('STORYBOARD_OVERLAY_ASSET_MISSING')
    if (overlay.end_ms > scene.duration_seconds * 1_000 || overlay.x + overlay.width > template.width || overlay.y + overlay.height > template.height) {
      throw new Error('STORYBOARD_OVERLAY_BOUNDS_INVALID')
    }
  }
  const storagePath = `tenants/${template.account_id}/artifacts/${template.date_path}/${template.output_name}`
  let uploadPath: string
  try {
    uploadPath = decodeURIComponent(new URL(template.upload_url).pathname).replace(/^\/+/, '')
  } catch {
    throw new Error('STORYBOARD_UPLOAD_PATH_MISMATCH')
  }
  if (uploadPath !== storagePath) throw new Error('STORYBOARD_UPLOAD_PATH_MISMATCH')

  let cursorMs = 0
  const subtitles = script.scenes.flatMap((scene) => {
    const start = cursorMs
    cursorMs += Math.round(scene.duration_seconds * 1_000)
    const text = scene.overlay ?? scene.narration
    const words = scene.word_timings?.map((word) => ({ ...word, start_ms: start + word.start_ms, end_ms: start + word.end_ms }))
    return text ? [{ start_ms: start, end_ms: cursorMs, text: text.slice(0, 300), style: words?.length ? 'karaoke' as const : 'standard' as const, words }] : []
  })
  let overlayCursorMs = 0
  const overlays = script.scenes.flatMap((scene) => {
    const offset = overlayCursorMs; overlayCursorMs += Math.round(scene.duration_seconds * 1_000)
    return scene.image_overlays.map((overlay) => ({ ...overlay, start_ms: offset + overlay.start_ms, end_ms: offset + overlay.end_ms }))
  })
  return MediaJobPayloadSchema.parse({
    kind: 'ffmpeg_assembly',
    output_name: template.output_name,
    output: {
      storage_path: storagePath,
      upload_url: template.upload_url,
      expires_at: template.expires_at,
    },
    assets: template.assets,
    clips: script.scenes.map((scene) => ({ asset_id: scene.asset_id, duration_seconds: scene.duration_seconds, transition: scene.transition })),
    overlays,
    subtitles,
    voice_asset_id: template.voice_asset_id,
    background_audio_asset_id: template.background_audio_asset_id,
    background_volume: template.background_volume,
    format_preset: template.format_preset,
    width: template.width,
    height: template.height,
    fps: template.fps,
    video_bitrate_kbps: template.video_bitrate_kbps,
    max_output_bytes: template.max_output_bytes,
    codec: template.codec,
    seed: template.seed,
  })
}
