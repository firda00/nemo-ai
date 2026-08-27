import { spawn } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { killTree, type FfmpegCapabilities } from './ffmpeg-engine.ts'
import { escapeFilterPath } from './subtitles.ts'

export const MEDIA_MEMORY_CEILING_BYTES = 1024 * 1024 * 1024
/** DB/RPC compatibility is PROFILE_C_BROWSER; product terminology is PROFILE_C_MEDIA. */
export const PROFILE_C_MEDIA = 'PROFILE_C_BROWSER' as const
export const MEDIA_TIMEOUT_MS = 120_000
export const MAX_MEDIA_OUTPUT_BYTES = 256 * 1024 * 1024
const MAX_CAPTURE_BYTES = 64 * 1024

const SafeNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mp4|webm)$/i)
const StoragePathSchema = z.string().max(512).regex(/^tenants\/[0-9a-f-]{36}\/artifacts\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]{1,160}$/)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const MediaRightsSchema = z.object({
  source_type: z.enum(['owned', 'commissioned', 'cc0', 'licensed_stock', 'provider_generated']),
  license_identifier: z.string().min(1).max(160),
  proof_ref: z.string().min(1).max(512),
  commercial_use_allowed: z.literal(true),
  derivatives_allowed: z.literal(true),
  verified_at: z.string().datetime({ offset: true }),
  attribution_text: z.string().max(500).optional(),
}).strict().superRefine((rights, context) => {
  if (rights.source_type === 'cc0' && rights.license_identifier !== 'CC0-1.0') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'CC0 assets require license_identifier CC0-1.0', path: ['license_identifier'] })
  }
})

export const MediaAssetSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  download_url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']),
  size_bytes: z.number().int().positive().max(512 * 1024 * 1024),
  sha256: Sha256Schema,
  rights: MediaRightsSchema.optional(),
}).strict()

const MotionSchema = z.enum(['none', 'push_in', 'pan_left', 'pan_right', 'float'])
const TransitionSchema = z.object({
  type: z.enum(['cut', 'fade', 'crossfade', 'wipe_left', 'slide_left', 'smooth_left']),
  duration_seconds: z.number().min(0.1).max(3).default(0.5),
}).strict()

const ClipSchema = z.object({
  asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  /** Start offset inside a source video. Still images must use zero. */
  start_seconds: z.number().nonnegative().max(3_600).default(0),
  duration_seconds: z.number().positive().min(0.1).max(120),
  motion: MotionSchema.default('none'),
  transition: TransitionSchema.optional(),
}).strict()

const WordTimingSchema = z.object({ text: z.string().min(1).max(80), start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive() }).strict()
const SubtitleSchema = z.object({
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  text: z.string().min(1).max(300),
  style: z.enum(['standard', 'karaoke']).default('standard'),
  words: z.array(WordTimingSchema).max(80).optional(),
}).strict().superRefine((cue, context) => {
  if (cue.end_ms <= cue.start_ms) context.addIssue({ code: z.ZodIssueCode.custom, message: 'subtitle end must follow start' })
  for (const word of cue.words ?? []) if (word.start_ms < cue.start_ms || word.end_ms > cue.end_ms || word.end_ms <= word.start_ms) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'word timing must be inside subtitle cue', path: ['words'] })
  }
})

const OverlaySchema = z.object({
  asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  start_ms: z.number().int().nonnegative(), end_ms: z.number().int().positive(),
  x: z.number().int().min(0).max(1920), y: z.number().int().min(0).max(1920),
  width: z.number().int().min(16).max(1920), height: z.number().int().min(16).max(1080),
}).strict().refine((overlay) => overlay.end_ms > overlay.start_ms, 'overlay end must follow start')

export const MediaJobPayloadSchema = z.object({
  kind: z.literal('ffmpeg_assembly'),
  output_name: SafeNameSchema,
  output: z.object({
    storage_path: StoragePathSchema,
    upload_url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
    expires_at: z.string().datetime({ offset: true }),
  }).strict(),
  assets: z.array(MediaAssetSchema).min(1).max(64),
  clips: z.array(ClipSchema).min(1).max(100),
  audio_asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  voice_asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  background_audio_asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  background_volume: z.number().min(0.02).max(0.8).default(0.18),
  /** Optional EBU R128 integrated loudness target. When requested, loudnorm is mandatory. */
  target_loudness_lufs: z.number().min(-24).max(-10).optional(),
  procedural_soundtrack: z.object({
    preset: z.enum(['subtle', 'upbeat', 'cinematic']).default('subtle'),
    volume: z.number().min(0.01).max(0.25).default(0.06),
    transition_accents: z.boolean().default(true),
  }).strict().optional(),
  rights_policy: z.enum(['require_for_audio', 'require_for_all_assets']).default('require_for_audio'),
  overlays: z.array(OverlaySchema).max(32).default([]),
  subtitles: z.array(SubtitleSchema).max(2_000).default([]),
  format_preset: z.enum(['LANDSCAPE_16_9', 'VERTICAL_9_16', 'CUSTOM']).default('CUSTOM'),
  width: z.number().int().min(160).max(1920).default(1920),
  height: z.number().int().min(160).max(1920).default(1080),
  fps: z.number().int().min(1).max(60).default(30),
  video_bitrate_kbps: z.number().int().min(128).max(12_000).default(4_000),
  max_output_bytes: z.number().int().positive().max(MAX_MEDIA_OUTPUT_BYTES).default(256 * 1024 * 1024),
  codec: z.enum(['h264', 'h265', 'vp9']).default('h264'),
  seed: z.union([z.number().int(), z.string().max(128)]).default(0),
}).strict().superRefine((value, context) => {
  if (Math.max(value.width, value.height) > 1920 || Math.min(value.width, value.height) > 1080) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'resolution exceeds 1080p', path: ['width'] })
  }
  const ids = new Set(value.assets.map((asset) => asset.id))
  const assetsById = new Map(value.assets.map((asset) => [asset.id, asset]))
  if (ids.size !== value.assets.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'asset ids must be unique', path: ['assets'] })
  for (const clip of value.clips) if (!ids.has(clip.asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'clip asset is missing', path: ['clips'] })
  for (const [index, clip] of value.clips.entries()) {
    const asset = assetsById.get(clip.asset_id)
    if (asset?.mime_type.startsWith('image/') && clip.start_seconds !== 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'still images cannot have a source offset', path: ['clips', index, 'start_seconds'] })
    }
  }
  if (value.audio_asset_id && !ids.has(value.audio_asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'audio asset is missing', path: ['audio_asset_id'] })
  for (const field of ['voice_asset_id', 'background_audio_asset_id'] as const) if (value[field] && !ids.has(value[field]!)) context.addIssue({ code: z.ZodIssueCode.custom, message: `${field} asset is missing`, path: [field] })
  for (const overlay of value.overlays) if (!ids.has(overlay.asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'overlay asset is missing', path: ['overlays'] })
  if (value.format_preset === 'LANDSCAPE_16_9' && value.width / value.height !== 16 / 9) context.addIssue({ code: z.ZodIssueCode.custom, message: 'landscape preset requires 16:9', path: ['format_preset'] })
  if (value.format_preset === 'VERTICAL_9_16' && value.width / value.height !== 9 / 16) context.addIssue({ code: z.ZodIssueCode.custom, message: 'vertical preset requires 9:16', path: ['format_preset'] })
  if (value.clips.reduce((sum, clip) => sum + clip.duration_seconds, 0) > 600) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'media duration exceeds 600 seconds', path: ['clips'] })
  }
  if (value.assets.reduce((sum, asset) => sum + asset.size_bytes, 0) > 512 * 1024 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'aggregate input assets exceed 512 MiB', path: ['assets'] })
  }
  if (value.codec === 'vp9' && !value.output_name.toLowerCase().endsWith('.webm')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'VP9 requires WebM output', path: ['output_name'] })
  }
  if (value.codec !== 'vp9' && !value.output_name.toLowerCase().endsWith('.mp4')) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'H.264/H.265 require MP4 output', path: ['output_name'] })
  }
  const audioIds = [value.audio_asset_id, value.voice_asset_id, value.background_audio_asset_id].filter((id): id is string => Boolean(id))
  for (const assetId of audioIds) {
    const asset = assetsById.get(assetId)
    if (asset && !asset.mime_type.startsWith('audio/')) context.addIssue({ code: z.ZodIssueCode.custom, message: 'audio reference must point to an audio asset', path: ['assets'] })
    if (asset && !asset.rights) context.addIssue({ code: z.ZodIssueCode.custom, message: 'audio asset requires verified rights provenance', path: ['assets'] })
  }
  if (value.rights_policy === 'require_for_all_assets') {
    for (const [index, asset] of value.assets.entries()) if (!asset.rights) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'asset requires verified rights provenance', path: ['assets', index, 'rights'] })
    }
  }
}).refine((value) => value.output.storage_path.endsWith(`/${value.output_name}`), {
  message: 'storage path must end with the output name', path: ['output', 'storage_path'],
})

export type MediaJobPayload = z.infer<typeof MediaJobPayloadSchema>

export interface LocalMediaInputs {
  assets: Map<string, string>
  subtitlesPath: string | null
  outputPath: string
  workDirectory: string
}

export interface MediaProbe {
  width: number
  height: number
  fps: number
  durationSeconds: number
  bitRate: number | null
  codec: string
  container: string
}

export interface MediaPipelineResult {
  bytes: Uint8Array
  durationSeconds: number
  executionTimeMs: number
  probe: MediaProbe
}

export class MediaPipelineError extends Error {
  readonly code: 'MEDIA_TIMEOUT' | 'MEDIA_LIMIT_EXCEEDED' | 'MEDIA_RENDER_FAILED' | 'MEDIA_PROBE_FAILED'

  constructor(code: MediaPipelineError['code'], message: string) {
    super(message)
    this.name = 'MediaPipelineError'
    this.code = code
  }
}

export function sanitizedMediaSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: source.PATH || '/usr/bin:/bin',
    TMPDIR: source.TMPDIR || '/tmp',
    LC_ALL: 'C',
  }
}

export function assertPathInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(candidate)
  const relative = path.relative(resolvedRoot, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'media path escapes tmpfs workspace')
  return resolved
}

function codecArgs(payload: MediaJobPayload): string[] {
  if (payload.codec === 'h265') return ['-c:v', 'libx265', '-tag:v', 'hvc1']
  if (payload.codec === 'vp9') return ['-c:v', 'libvpx-vp9', '-row-mt', '1']
  return ['-c:v', 'libx264']
}

function motionFilter(
  motion: z.infer<typeof MotionSchema>,
  width: number,
  height: number,
  fps: number,
  durationSeconds: number,
): string | null {
  const frames = Math.max(1, Math.round(fps * durationSeconds))
  const common = `d=1:s=${width}x${height}:fps=${fps}`
  if (motion === 'push_in') return `zoompan=z='min(zoom+0.0012,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':${common}`
  if (motion === 'pan_left') return `zoompan=z=1.08:x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)':${common}`
  if (motion === 'pan_right') return `zoompan=z=1.08:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':${common}`
  if (motion === 'float') return `zoompan=z=1.05:x='iw/2-(iw/zoom/2)+sin(on/12)*6':y='ih/2-(ih/zoom/2)+cos(on/15)*4':${common}`
  return null
}

function xfadeName(type: z.infer<typeof TransitionSchema>['type']): string {
  if (type === 'fade') return 'fadeblack'
  if (type === 'wipe_left') return 'wipeleft'
  if (type === 'slide_left') return 'slideleft'
  if (type === 'smooth_left') return 'smoothleft'
  return 'fade'
}

export function buildFfmpegArgs(
  payload: MediaJobPayload,
  inputs: LocalMediaInputs,
  capabilities: FfmpegCapabilities,
): { args: string[]; durationSeconds: number } {
  const args = ['-hide_banner', '-nostdin', '-y', '-max_alloc', String(MEDIA_MEMORY_CEILING_BYTES)]
  const videoLabels: string[] = []
  const filters: string[] = []

  payload.clips.forEach((clip, index) => {
    const asset = payload.assets.find((candidate) => candidate.id === clip.asset_id)
    const localPath = inputs.assets.get(clip.asset_id)
    if (!asset || !localPath) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'materialized clip is missing')
    assertPathInside(inputs.workDirectory, localPath)
    if (asset.mime_type.startsWith('image/')) args.push('-loop', '1', '-framerate', String(payload.fps), '-t', String(clip.duration_seconds))
    else args.push('-ss', String(clip.start_seconds), '-t', String(clip.duration_seconds))
    args.push('-i', localPath)
    const label = `clip${index}`
    const chain = [
      `scale=${payload.width}:${payload.height}:force_original_aspect_ratio=increase`,
      `crop=${payload.width}:${payload.height}`,
    ]
    const motion = motionFilter(clip.motion, payload.width, payload.height, payload.fps, clip.duration_seconds)
    if (motion) {
      if (!asset.mime_type.startsWith('image/')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'motion presets are limited to still-image clips')
      if (!capabilities.has('zoompan')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg zoompan filter is required for requested motion')
      chain.push(motion)
    }
    if (capabilities.has('fps')) chain.push(`fps=${payload.fps}`)
    chain.push('format=yuv420p')
    if (capabilities.has('setsar')) chain.push('setsar=1')
    chain.push(`trim=duration=${clip.duration_seconds}`)
    if (capabilities.has('setpts')) chain.push('setpts=PTS-STARTPTS')
    filters.push(`[${index}:v]${chain.join(',')}[${label}]`)
    videoLabels.push(`[${label}]`)
  })

  let videoOut = 'vout'
  const transitions = payload.clips.slice(0, -1).map((clip) => clip.transition).filter((transition) => transition && transition.type !== 'cut')
  let durationSeconds = payload.clips.reduce((sum, clip) => sum + clip.duration_seconds, 0)
  if (transitions.length) {
    if (!capabilities.has('xfade')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg xfade filter is required for requested transitions')
    let previous = 'clip0'
    let cursor = payload.clips[0].duration_seconds
    for (let index = 1; index < payload.clips.length; index += 1) {
      const transition = payload.clips[index - 1].transition
      const transitionDuration = transition?.type === 'cut' || !transition ? 0.001 : transition.duration_seconds
      const output = index === payload.clips.length - 1 ? videoOut : `x${index}`
      const transitionName = xfadeName(transition?.type ?? 'crossfade')
      const offset = Math.max(0, cursor - transitionDuration)
      filters.push(`[${previous}][clip${index}]xfade=transition=${transitionName}:duration=${transitionDuration}:offset=${offset}[${output}]`)
      cursor = offset + payload.clips[index].duration_seconds
      durationSeconds = cursor
      previous = output
    }
  } else {
    filters.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[${videoOut}]`)
  }

  let nextInputIndex = payload.clips.length
  for (let index = 0; index < payload.overlays.length; index += 1) {
    const overlay = payload.overlays[index]
    const asset = payload.assets.find((candidate) => candidate.id === overlay.asset_id)
    const overlayPath = inputs.assets.get(overlay.asset_id)
    if (!capabilities.has('overlay')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg overlay filter is required for image overlays')
    if (!asset?.mime_type.startsWith('image/') || !overlayPath) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'overlay must be a materialized image')
    assertPathInside(inputs.workDirectory, overlayPath)
    args.push('-loop', '1', '-i', overlayPath)
    const scaled = `ov${index}`; const composed = `vov${index}`
    filters.push(`[${nextInputIndex}:v]scale=${overlay.width}:${overlay.height},format=rgba[${scaled}]`)
    filters.push(`[${videoOut}][${scaled}]overlay=${overlay.x}:${overlay.y}:enable='between(t,${overlay.start_ms / 1000},${overlay.end_ms / 1000})'[${composed}]`)
    videoOut = composed; nextInputIndex += 1
  }
  if (inputs.subtitlesPath) {
    if (!capabilities.has('ass')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg ass filter is required for burn-in subtitles')
    assertPathInside(inputs.workDirectory, inputs.subtitlesPath)
    filters.push(`[${videoOut}]ass='${escapeFilterPath(inputs.subtitlesPath)}'[vsub]`)
    videoOut = 'vsub'
  }

  let audioOut: string | null = null
  const voiceId = payload.voice_asset_id ?? payload.audio_asset_id
  const musicId = payload.background_audio_asset_id
  const addAudio = (assetId: string): number => {
    const audioPath = inputs.assets.get(assetId)
    if (!audioPath) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'materialized audio is missing')
    assertPathInside(inputs.workDirectory, audioPath); args.push('-i', audioPath); return nextInputIndex++
  }
  if (voiceId && musicId) {
    if (!capabilities.has('amix')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg amix filter is required for voice and music')
    const voiceIndex = addAudio(voiceId); const musicIndex = addAudio(musicId)
    filters.push(`[${voiceIndex}:a]apad,atrim=duration=${durationSeconds}[voice]`)
    filters.push(`[${musicIndex}:a]volume=${payload.background_volume},apad,atrim=duration=${durationSeconds}[music]`)
    if (capabilities.has('sidechaincompress')) {
      filters.push('[music][voice]sidechaincompress=threshold=0.04:ratio=10:attack=20:release=400[ducked]')
      filters.push('[voice][ducked]amix=inputs=2:duration=first:normalize=0[aout]')
    } else filters.push('[voice][music]amix=inputs=2:duration=first:normalize=0[aout]')
    audioOut = 'aout'
  } else if (voiceId || musicId) {
    const audioIndex = addAudio((voiceId ?? musicId)!)
    const volume = musicId ? `volume=${payload.background_volume},` : ''
    filters.push(`[${audioIndex}:a]${volume}apad,atrim=duration=${durationSeconds}[aout]`); audioOut = 'aout'
  }

  if (payload.procedural_soundtrack) {
    for (const required of ['sine', 'afade']) if (!capabilities.has(required)) {
      throw new MediaPipelineError('MEDIA_RENDER_FAILED', `FFmpeg ${required} filter is required for procedural sound design`)
    }
    const frequency = payload.procedural_soundtrack.preset === 'cinematic' ? 82 : payload.procedural_soundtrack.preset === 'upbeat' ? 196 : 110
    const fadeOutStart = Math.max(0, durationSeconds - 0.8)
    filters.push(`sine=frequency=${frequency}:sample_rate=48000:duration=${durationSeconds},volume=${payload.procedural_soundtrack.volume},afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeOutStart}:d=0.8[ambient]`)
    const accentLabels: string[] = []
    if (payload.procedural_soundtrack.transition_accents && payload.clips.length > 1) {
      if (!capabilities.has('adelay')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg adelay filter is required for transition sound accents')
      let cursorMs = 0
      for (let index = 0; index < payload.clips.length - 1; index += 1) {
        cursorMs += Math.round(payload.clips[index].duration_seconds * 1_000)
        const label = `accent${index}`
        filters.push(`sine=frequency=${frequency * 4}:sample_rate=48000:duration=0.12,volume=0.025,afade=t=out:st=0:d=0.12,adelay=${cursorMs}|${cursorMs}[${label}]`)
        accentLabels.push(`[${label}]`)
      }
    }
    let proceduralOut = 'ambient'
    if (accentLabels.length) {
      if (!capabilities.has('amix')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg amix filter is required for procedural sound accents')
      filters.push(`[ambient]${accentLabels.join('')}amix=inputs=${accentLabels.length + 1}:duration=first:normalize=0[procedural]`)
      proceduralOut = 'procedural'
    }
    if (audioOut) {
      if (!capabilities.has('amix')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg amix filter is required for soundtrack mixing')
      filters.push(`[${audioOut}][${proceduralOut}]amix=inputs=2:duration=first:normalize=0[aenhanced]`)
      audioOut = 'aenhanced'
    } else audioOut = proceduralOut
  }

  if (audioOut && payload.target_loudness_lufs !== undefined) {
    if (!capabilities.has('loudnorm')) {
      throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg loudnorm filter is required for the requested loudness target')
    }
    filters.push(`[${audioOut}]loudnorm=I=${payload.target_loudness_lufs}:TP=-1.5:LRA=11[anormalized]`)
    audioOut = 'anormalized'
  }

  assertPathInside(inputs.workDirectory, inputs.outputPath)
  args.push('-filter_complex', filters.join(';'), '-map', `[${videoOut}]`)
  if (audioOut) args.push('-map', `[${audioOut}]`)
  else args.push('-an')
  args.push(...codecArgs(payload))
  if (payload.codec === 'vp9') args.push('-deadline', 'good', '-cpu-used', '4')
  else args.push('-preset', 'veryfast')
  args.push(
    '-pix_fmt', 'yuv420p', '-r', String(payload.fps),
    '-b:v', `${payload.video_bitrate_kbps}k`, '-maxrate', `${payload.video_bitrate_kbps}k`,
    '-bufsize', `${payload.video_bitrate_kbps * 2}k`,
  )
  if (audioOut) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000')
  if (payload.codec !== 'vp9') args.push('-movflags', '+faststart')
  args.push('-t', String(durationSeconds), '-threads', '4', inputs.outputPath)
  return { args, durationSeconds }
}

async function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string; timedOut: boolean }> {
  const controller = new AbortController()
  let timedOut = false
  let stderr = ''
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  const child = spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    signal: controller.signal,
    env: sanitizedMediaSubprocessEnv(),
  })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-MAX_CAPTURE_BYTES) })
  const code = await new Promise<number>((resolve) => {
    let settled = false
    const finish = (value: number) => { if (!settled) { settled = true; resolve(value) } }
    child.on('error', () => finish(1))
    child.on('close', (value) => finish(value ?? 1))
  })
  clearTimeout(timer)
  if (timedOut) killTree(child.pid)
  return { code, stderr, timedOut }
}

function fraction(value: string | undefined): number {
  if (!value) return 0
  const [numerator, denominator] = value.split('/').map(Number)
  return denominator ? numerator / denominator : numerator
}

export async function probeMediaOutput(ffprobePath: string, outputPath: string, workDirectory: string): Promise<MediaProbe> {
  assertPathInside(workDirectory, outputPath)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  const child = spawn(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,bit_rate:format=duration,bit_rate,format_name',
    '-of', 'json', outputPath,
  ], {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: controller.signal,
    env: sanitizedMediaSubprocessEnv(),
  })
  const stdout: Buffer[] = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  const code = await new Promise<number>((resolve) => {
    child.on('error', () => resolve(1))
    child.on('close', (value) => resolve(value ?? 1))
  })
  clearTimeout(timer)
  if (code !== 0) throw new MediaPipelineError('MEDIA_PROBE_FAILED', 'ffprobe rejected rendered media')
  const raw = JSON.parse(Buffer.concat(stdout).toString('utf8')) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; bit_rate?: string }>
    format?: { duration?: string; bit_rate?: string; format_name?: string }
  }
  const stream = raw.streams?.[0]
  if (!stream) throw new MediaPipelineError('MEDIA_PROBE_FAILED', 'rendered media has no video stream')
  return {
    width: Number(stream.width ?? 0), height: Number(stream.height ?? 0), fps: fraction(stream.avg_frame_rate),
    durationSeconds: Number(raw.format?.duration ?? 0),
    bitRate: Number(stream.bit_rate ?? raw.format?.bit_rate) || null,
    codec: String(stream.codec_name ?? ''),
    container: String(raw.format?.format_name ?? ''),
  }
}

export async function runFfmpegPipeline(options: {
  payload: MediaJobPayload
  inputs: LocalMediaInputs
  capabilities: FfmpegCapabilities
  ffmpegPath: string
  ffprobePath: string
  timeoutMs?: number
}): Promise<MediaPipelineResult> {
  const payload = MediaJobPayloadSchema.parse(options.payload)
  const startedAt = performance.now()
  const plan = buildFfmpegArgs(payload, options.inputs, options.capabilities)
  const execution = await runProcess(options.ffmpegPath, plan.args, Math.min(MEDIA_TIMEOUT_MS, Math.max(10, options.timeoutMs ?? MEDIA_TIMEOUT_MS)))
  if (execution.timedOut) throw new MediaPipelineError('MEDIA_TIMEOUT', 'FFmpeg exceeded 120 seconds')
  if (execution.code !== 0) throw new MediaPipelineError('MEDIA_RENDER_FAILED', execution.stderr || 'FFmpeg failed')
  const outputInfo = await lstat(options.inputs.outputPath)
  if (!outputInfo.isFile() || outputInfo.isSymbolicLink()) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg output is not a regular file')
  if (outputInfo.size > payload.max_output_bytes || outputInfo.size > MAX_MEDIA_OUTPUT_BYTES) {
    throw new MediaPipelineError('MEDIA_LIMIT_EXCEEDED', 'rendered media exceeds the output size limit')
  }
  const probe = await probeMediaOutput(options.ffprobePath, options.inputs.outputPath, options.inputs.workDirectory)
  if (probe.width > payload.width || probe.height > payload.height || probe.fps > payload.fps + 0.01) {
    throw new MediaPipelineError('MEDIA_LIMIT_EXCEEDED', 'rendered media exceeds resolution or frame-rate policy')
  }
  if (probe.bitRate && probe.bitRate > payload.video_bitrate_kbps * 1_000 * 1.35 + 256_000) {
    throw new MediaPipelineError('MEDIA_LIMIT_EXCEEDED', 'rendered media exceeds bitrate policy')
  }
  const expectedCodec = payload.codec === 'h265' ? 'hevc' : payload.codec
  const expectedContainer = payload.codec === 'vp9' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2'
  if (probe.codec !== expectedCodec || probe.container !== expectedContainer) {
    throw new MediaPipelineError('MEDIA_PROBE_FAILED', 'rendered codec or container does not match MIME policy')
  }
  if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0 || probe.durationSeconds > plan.durationSeconds + 0.25) {
    throw new MediaPipelineError('MEDIA_PROBE_FAILED', 'rendered duration is invalid')
  }
  return {
    bytes: new Uint8Array(await readFile(options.inputs.outputPath)),
    durationSeconds: probe.durationSeconds,
    executionTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
    probe,
  }
}

export function deriveFfprobePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(?:\.exe)?$/i, (match) => match.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe')
}

export async function assertRegularInput(filePath: string, workDirectory: string, expectedBytes: number): Promise<void> {
  assertPathInside(workDirectory, filePath)
  const info = await lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedBytes) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'materialized asset size mismatch')
}
