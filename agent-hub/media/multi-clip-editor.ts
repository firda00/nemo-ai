import { createHash } from 'node:crypto'
import {
  MediaIntakePayloadSchema,
  type MediaIntakePayload,
  type SpeechSegment,
  type VideoClipInput,
} from '../../src/types/forge-media-intake.ts'
import { MediaJobPayloadSchema, type MediaJobPayload } from './ffmpeg-pipeline.ts'
import { buildAssFile, buildSrtFile, type ProSubtitleCue } from './subtitles.ts'

export const SILENCE_CUT_THRESHOLD_MS = 400
export const TARGET_PROGRAM_LOUDNESS_LUFS = -14
const MIN_SEGMENT_MS = 300

export class MultiClipEditorError extends Error {
  readonly code: 'RIGHTS_REJECTED' | 'NO_USABLE_MEDIA' | 'INVALID_INTAKE'

  constructor(code: MultiClipEditorError['code'], message: string) {
    super(message)
    this.name = 'MultiClipEditorError'
    this.code = code
  }
}

export interface SelectedMediaSegment {
  clipId: string
  sourceStartMs: number
  sourceEndMs: number
  transcript: string | null
  words: SpeechSegment['words']
}

export interface MultiClipEditPlan {
  mediaJob: MediaJobPayload
  selectedSegments: SelectedMediaSegment[]
  assSubtitles: string
  srtSubtitles: string
  analysis: {
    inputDurationMs: number
    outputDurationMs: number
    removedSilenceMs: number
    trimmedForDurationCapMs: number
    silenceThresholdMs: number
    targetProgramLoudnessLufs: number
    rightsVerifiedAssets: number
  }
}

function assetId(clipId: string): string {
  return `clip_${clipId.replaceAll('-', '')}`
}

function selectSegments(clip: VideoClipInput, thresholdMs: number): SelectedMediaSegment[] {
  if (!clip.speechSegments.length) {
    return [{
      clipId: clip.clipId,
      sourceStartMs: 0,
      sourceEndMs: Math.round(clip.durationSeconds * 1_000),
      transcript: null,
      words: [],
    }]
  }
  const speech = clip.speechSegments
    .filter((segment) => segment.endMs - segment.startMs >= MIN_SEGMENT_MS)
    .map((segment) => ({
      clipId: clip.clipId,
      sourceStartMs: segment.startMs,
      sourceEndMs: segment.endMs,
      transcript: segment.text,
      words: segment.words,
    }))
  const merged: SelectedMediaSegment[] = []
  for (const segment of speech) {
    const previous = merged.at(-1)
    if (previous && segment.sourceStartMs - previous.sourceEndMs <= thresholdMs) {
      previous.sourceEndMs = segment.sourceEndMs
      previous.transcript = [previous.transcript, segment.transcript].filter(Boolean).join(' ')
      previous.words = [...previous.words, ...segment.words]
    } else merged.push({ ...segment, words: [...segment.words] })
  }
  return merged
}

/** Consume trusted ASR/VAD timings; the render worker never sends media to a transcription network. */
export function removeLongPauses(clips: readonly VideoClipInput[], thresholdMs = SILENCE_CUT_THRESHOLD_MS): SelectedMediaSegment[] {
  if (!Number.isInteger(thresholdMs) || thresholdMs < 100 || thresholdMs > 5_000) {
    throw new MultiClipEditorError('INVALID_INTAKE', 'silence threshold must be between 100 and 5000 ms')
  }
  const selected = clips.flatMap((clip) => selectSegments(clip, thresholdMs))
  if (!selected.length) throw new MultiClipEditorError('NO_USABLE_MEDIA', 'no speech segment is long enough to render')
  return selected
}

function assertRights(payload: MediaIntakePayload): void {
  for (const clip of payload.clips) {
    const rights = clip.rightsManifest
    if (!rights.commercialAllowed || !rights.derivativesAllowed || rights.sha256 !== clip.sha256 || rights.assetId !== clip.clipId) {
      throw new MultiClipEditorError('RIGHTS_REJECTED', `rights verification failed for clip ${clip.clipId}`)
    }
  }
}

function dimensions(ratio: MediaIntakePayload['targetRatio']): { width: number; height: number; preset: MediaJobPayload['format_preset'] } {
  if (ratio === '9:16') return { width: 1080, height: 1920, preset: 'VERTICAL_9_16' }
  if (ratio === '1:1') return { width: 1080, height: 1080, preset: 'CUSTOM' }
  return { width: 1920, height: 1080, preset: 'LANDSCAPE_16_9' }
}

function capSegments(segments: readonly SelectedMediaSegment[], maxDurationMs: number): SelectedMediaSegment[] {
  const output: SelectedMediaSegment[] = []
  let remaining = maxDurationMs
  for (const segment of segments) {
    if (remaining < MIN_SEGMENT_MS) break
    const duration = Math.min(segment.sourceEndMs - segment.sourceStartMs, remaining)
    if (duration < MIN_SEGMENT_MS) continue
    const sourceEndMs = segment.sourceStartMs + duration
    output.push({
      ...segment,
      sourceEndMs,
      words: segment.words.filter((word) => word.startMs < sourceEndMs).map((word) => ({ ...word, endMs: Math.min(word.endMs, sourceEndMs) })),
    })
    remaining -= duration
  }
  if (!output.length) throw new MultiClipEditorError('NO_USABLE_MEDIA', 'duration cap leaves no usable media')
  return output
}

function subtitleCues(segments: readonly SelectedMediaSegment[], karaoke: boolean): ProSubtitleCue[] {
  const cues: ProSubtitleCue[] = []
  let outputCursorMs = 0
  for (const segment of segments) {
    const durationMs = segment.sourceEndMs - segment.sourceStartMs
    if (segment.transcript) {
      const words = segment.words.map((word) => ({
        text: word.text,
        startMs: outputCursorMs + Math.max(0, word.startMs - segment.sourceStartMs),
        endMs: outputCursorMs + Math.min(durationMs, word.endMs - segment.sourceStartMs),
      })).filter((word) => word.endMs > word.startMs)
      cues.push({
        text: segment.transcript,
        startMs: outputCursorMs,
        endMs: outputCursorMs + durationMs,
        style: karaoke ? 'karaoke' : 'standard',
        words: karaoke ? words : undefined,
      })
    }
    outputCursorMs += durationMs
  }
  return cues
}

function toAssColour(hex: string): string {
  const value = hex.slice(1)
  return `&H00${value.slice(4, 6)}${value.slice(2, 4)}${value.slice(0, 2)}`.toUpperCase()
}

export function compileMultiClipEditPlan(raw: unknown): MultiClipEditPlan {
  const parsed = MediaIntakePayloadSchema.safeParse(raw)
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`).join('; ')
    throw new MultiClipEditorError('INVALID_INTAKE', message)
  }
  const payload = parsed.data
  assertRights(payload)

  const allSegments = removeLongPauses(payload.clips)
  const selectedSegments = capSegments(allSegments, Math.round(payload.maxDurationSeconds * 1_000))
  const cues = subtitleCues(selectedSegments, payload.subtitleStyle === 'dynamic_karaoke')
  const frame = dimensions(payload.targetRatio)
  const assets = payload.clips.map((clip) => ({
    id: assetId(clip.clipId),
    download_url: clip.downloadUrl,
    mime_type: clip.mimeType,
    size_bytes: clip.sizeBytes,
    sha256: clip.sha256,
    rights: {
      source_type: clip.rightsManifest.licenseType,
      license_identifier: clip.rightsManifest.licenseIdentifier,
      proof_ref: clip.rightsManifest.proofRef,
      commercial_use_allowed: true as const,
      derivatives_allowed: true as const,
      verified_at: clip.rightsManifest.verifiedAt,
      attribution_text: clip.rightsManifest.attributionText,
    },
  }))
  const clips = selectedSegments.map((segment, index) => {
    const durationSeconds = (segment.sourceEndMs - segment.sourceStartMs) / 1_000
    const isLast = index === selectedSegments.length - 1
    const transitionDuration = Math.max(0.1, Math.min(0.35, durationSeconds / 3))
    return {
      asset_id: assetId(segment.clipId),
      start_seconds: segment.sourceStartMs / 1_000,
      duration_seconds: durationSeconds,
      // Source videos are not given still-image zoompan effects. Dynamic movement
      // comes from cuts/crossfades and source framing, avoiding invalid filters.
      motion: 'none' as const,
      transition: isLast ? undefined : {
        type: payload.targetPreset === 'cinematic_short' ? 'crossfade' as const : 'fade' as const,
        duration_seconds: transitionDuration,
      },
    }
  })

  const mediaJob = MediaJobPayloadSchema.parse({
    kind: 'ffmpeg_assembly',
    output_name: payload.output.name,
    output: {
      storage_path: payload.output.storagePath,
      upload_url: payload.output.uploadUrl,
      expires_at: payload.output.expiresAt,
    },
    assets,
    clips,
    rights_policy: 'require_for_all_assets',
    subtitles: cues.map((cue) => ({
      start_ms: cue.startMs,
      end_ms: cue.endMs,
      text: cue.text,
      style: cue.style,
      words: cue.words?.map((word) => ({ text: word.text, start_ms: word.startMs, end_ms: word.endMs })),
    })),
    procedural_soundtrack: {
      preset: payload.targetPreset === 'cinematic_short' ? 'cinematic' : 'subtle',
      volume: payload.targetPreset === 'cinematic_short' ? 0.055 : 0.04,
      transition_accents: true,
    },
    background_volume: 0.15,
    target_loudness_lufs: TARGET_PROGRAM_LOUDNESS_LUFS,
    format_preset: frame.preset,
    width: frame.width,
    height: frame.height,
    fps: 30,
    video_bitrate_kbps: payload.targetPreset === 'cinematic_short' ? 5_000 : 4_000,
    codec: payload.output.name.toLowerCase().endsWith('.webm') ? 'vp9' : 'h264',
    seed: payload.seed,
  })

  const outputDurationMs = selectedSegments.reduce((total, segment) => total + segment.sourceEndMs - segment.sourceStartMs, 0)
  const inputDurationMs = payload.clips.reduce((total, clip) => total + Math.round(clip.durationSeconds * 1_000), 0)
  const speechTimelineDurationMs = allSegments.reduce((total, segment) => total + segment.sourceEndMs - segment.sourceStartMs, 0)
  const style = {
    fontName: payload.brand.fontFamily,
    primaryColour: toAssColour(payload.brand.colors[1] ?? '#FFFFFF'),
    highlightColour: toAssColour(payload.brand.colors[0]),
    playResX: frame.width,
    playResY: frame.height,
    marginV: Math.round(frame.height * 0.18),
    fontSize: payload.targetRatio === '9:16' ? 86 : 64,
  }
  return {
    mediaJob,
    selectedSegments,
    assSubtitles: buildAssFile(cues, style),
    srtSubtitles: buildSrtFile(cues),
    analysis: {
      inputDurationMs,
      outputDurationMs,
      removedSilenceMs: Math.max(0, inputDurationMs - speechTimelineDurationMs),
      trimmedForDurationCapMs: Math.max(0, speechTimelineDurationMs - outputDurationMs),
      silenceThresholdMs: SILENCE_CUT_THRESHOLD_MS,
      targetProgramLoudnessLufs: TARGET_PROGRAM_LOUDNESS_LUFS,
      rightsVerifiedAssets: payload.clips.length,
    },
  }
}

export function sha256MediaArtifact(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
