import { spawn } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { killTree, type FfmpegCapabilities } from './ffmpeg-engine.ts'
import { escapeFilterPath } from './subtitles.ts'

export const MEDIA_MEMORY_CEILING_BYTES = 1024 * 1024 * 1024
export const MEDIA_TIMEOUT_MS = 120_000
export const MAX_MEDIA_OUTPUT_BYTES = 256 * 1024 * 1024
const MAX_CAPTURE_BYTES = 64 * 1024

const SafeNameSchema = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mp4|webm)$/i)
const StoragePathSchema = z.string().max(512).regex(/^tenants\/[0-9a-f-]{36}\/artifacts\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._-]{1,160}$/)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)

export const MediaAssetSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  download_url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm', 'audio/wav', 'audio/mpeg', 'audio/mp4']),
  size_bytes: z.number().int().positive().max(512 * 1024 * 1024),
  sha256: Sha256Schema,
}).strict()

const ClipSchema = z.object({
  asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  duration_seconds: z.number().positive().min(0.1).max(120),
}).strict()

const SubtitleSchema = z.object({
  start_ms: z.number().int().nonnegative(),
  end_ms: z.number().int().positive(),
  text: z.string().min(1).max(300),
}).strict().refine((cue) => cue.end_ms > cue.start_ms, { message: 'subtitle end must follow start' })

export const MediaJobPayloadSchema = z.object({
  kind: z.literal('ffmpeg_assembly'),
  output_name: SafeNameSchema,
  output: z.object({
    storage_path: StoragePathSchema,
    upload_url: z.string().url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required'),
    expires_at: z.string().datetime(),
  }).strict(),
  assets: z.array(MediaAssetSchema).min(1).max(64),
  clips: z.array(ClipSchema).min(1).max(100),
  audio_asset_id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  subtitles: z.array(SubtitleSchema).max(2_000).default([]),
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
  if (ids.size !== value.assets.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'asset ids must be unique', path: ['assets'] })
  for (const clip of value.clips) if (!ids.has(clip.asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'clip asset is missing', path: ['clips'] })
  if (value.audio_asset_id && !ids.has(value.audio_asset_id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'audio asset is missing', path: ['audio_asset_id'] })
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

export function buildFfmpegArgs(
  payload: MediaJobPayload,
  inputs: LocalMediaInputs,
  capabilities: FfmpegCapabilities,
): { args: string[]; durationSeconds: number } {
  const durationSeconds = payload.clips.reduce((sum, clip) => sum + clip.duration_seconds, 0)
  const args = ['-hide_banner', '-nostdin', '-y', '-max_alloc', String(MEDIA_MEMORY_CEILING_BYTES)]
  const videoLabels: string[] = []
  const filters: string[] = []

  payload.clips.forEach((clip, index) => {
    const asset = payload.assets.find((candidate) => candidate.id === clip.asset_id)
    const localPath = inputs.assets.get(clip.asset_id)
    if (!asset || !localPath) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'materialized clip is missing')
    assertPathInside(inputs.workDirectory, localPath)
    if (asset.mime_type.startsWith('image/')) args.push('-loop', '1', '-framerate', String(payload.fps), '-t', String(clip.duration_seconds))
    args.push('-i', localPath)
    const label = `clip${index}`
    const chain = [
      `scale=${payload.width}:${payload.height}:force_original_aspect_ratio=increase`,
      `crop=${payload.width}:${payload.height}`,
    ]
    if (capabilities.has('fps')) chain.push(`fps=${payload.fps}`)
    chain.push('format=yuv420p')
    if (capabilities.has('setsar')) chain.push('setsar=1')
    chain.push(`trim=duration=${clip.duration_seconds}`)
    if (capabilities.has('setpts')) chain.push('setpts=PTS-STARTPTS')
    filters.push(`[${index}:v]${chain.join(',')}[${label}]`)
    videoLabels.push(`[${label}]`)
  })

  let videoOut = 'vout'
  filters.push(`${videoLabels.join('')}concat=n=${videoLabels.length}:v=1:a=0[${videoOut}]`)
  if (inputs.subtitlesPath) {
    if (!capabilities.has('ass')) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'FFmpeg ass filter is required for burn-in subtitles')
    assertPathInside(inputs.workDirectory, inputs.subtitlesPath)
    filters.push(`[${videoOut}]ass='${escapeFilterPath(inputs.subtitlesPath)}'[vsub]`)
    videoOut = 'vsub'
  }

  let audioOut: string | null = null
  if (payload.audio_asset_id) {
    const audioPath = inputs.assets.get(payload.audio_asset_id)
    if (!audioPath) throw new MediaPipelineError('MEDIA_RENDER_FAILED', 'materialized audio is missing')
    assertPathInside(inputs.workDirectory, audioPath)
    const audioIndex = payload.clips.length
    args.push('-i', audioPath)
    filters.push(`[${audioIndex}:a]apad,atrim=duration=${durationSeconds}[aout]`)
    audioOut = 'aout'
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
