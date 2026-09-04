import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { MediaIntakePayloadSchema } from '../src/types/forge-media-intake.ts'
import {
  compileMultiClipEditPlan,
  MultiClipEditorError,
  removeLongPauses,
  sha256MediaArtifact,
} from '../agent-hub/media/multi-clip-editor.ts'
import { buildFfmpegArgs } from '../agent-hub/media/ffmpeg-pipeline.ts'
import type { FfmpegCapabilities } from '../agent-hub/media/ffmpeg-engine.ts'

const ACCOUNT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b801'
const PROJECT_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b802'
const WORKFLOW_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b803'
const EXECUTION_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b804'
const STEP_ID = '01917b12-3a5c-7d9e-bf33-9118c7e7b805'
const HASHES = [
  '1'.repeat(64),
  '2'.repeat(64),
  '3'.repeat(64),
]

function makeClip(index: number) {
  const clipId = `01917b12-3a5c-7d9e-bf33-9118c7e7b81${index}`
  const startMs = index * 100
  return {
    clipId,
    stagedPath: `tenants/${ACCOUNT_ID}/uploads/session-${PROJECT_ID}/clip-${index}.mp4`,
    downloadUrl: `https://storage.example.test/tenants/${ACCOUNT_ID}/uploads/session-${PROJECT_ID}/clip-${index}.mp4?signature=test`,
    mimeType: 'video/mp4' as const,
    sizeBytes: 2_000_000,
    sha256: HASHES[index],
    durationSeconds: 6,
    width: 1920,
    height: 1080,
    fps: 30,
    speechSegments: [{
      startMs: 700 + startMs,
      endMs: 1_900 + startMs,
      text: `Фраза номер ${index + 1}`,
      words: [
        { text: 'Фраза', startMs: 700 + startMs, endMs: 1_050 + startMs, confidence: 0.98 },
        { text: 'номер', startMs: 1_150 + startMs, endMs: 1_450 + startMs, confidence: 0.97 },
        { text: String(index + 1), startMs: 1_550 + startMs, endMs: 1_900 + startMs, confidence: 0.99 },
      ],
    }],
    rightsManifest: {
      assetId: clipId,
      sha256: HASHES[index],
      licenseType: index === 0 ? 'owned' as const : 'commissioned' as const,
      licenseIdentifier: index === 0 ? 'OWNER-UPLOAD-v1' : 'COMMISSION-2026-08',
      owner: 'Demo tenant',
      proofRef: `rights://${ACCOUNT_ID}/${clipId}`,
      verifiedAt: '2026-08-27T12:00:00+05:00',
      commercialAllowed: true as const,
      derivativesAllowed: true as const,
    },
  }
}

const rawPayload = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  workflowId: WORKFLOW_ID,
  executionId: EXECUTION_ID,
  stepId: STEP_ID,
  clips: [makeClip(0), makeClip(1), makeClip(2)],
  targetPreset: 'cinematic_short' as const,
  targetRatio: '9:16' as const,
  maxDurationSeconds: 15,
  language: 'ru' as const,
  subtitleStyle: 'dynamic_karaoke' as const,
  brand: { colors: ['#00F0FF', '#FFFFFF'], fontFamily: 'Inter' as const },
  output: {
    name: 'campaign-short.mp4',
    storagePath: `tenants/${ACCOUNT_ID}/artifacts/2026/08/27/campaign-short.mp4`,
    uploadUrl: `https://storage.example.test/tenants/${ACCOUNT_ID}/artifacts/2026/08/27/campaign-short.mp4?signature=test`,
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
  },
  seed: 42,
}

const parsed = MediaIntakePayloadSchema.parse(rawPayload)
assert.equal(parsed.clips.length, 3)
assert.equal(removeLongPauses(parsed.clips).length, 3)
const naturalPauseClip = structuredClone(parsed.clips[0])
naturalPauseClip.speechSegments.push({
  startMs: 2_200,
  endMs: 3_000,
  text: 'Продолжение мысли',
  words: [
    { text: 'Продолжение', startMs: 2_200, endMs: 2_600, confidence: 0.98 },
    { text: 'мысли', startMs: 2_650, endMs: 3_000, confidence: 0.98 },
  ],
})
assert.equal(removeLongPauses([naturalPauseClip], 400).length, 1, 'natural pauses up to 400 ms must be retained')
assert.equal(removeLongPauses([naturalPauseClip], 200).length, 2, 'pauses above the threshold must be cut')

const plan = compileMultiClipEditPlan(rawPayload)
assert.equal(plan.analysis.rightsVerifiedAssets, 3)
assert.equal(plan.mediaJob.clips.length, 3)
assert.equal(plan.mediaJob.clips[0].start_seconds, 0.7)
assert.equal(plan.mediaJob.format_preset, 'VERTICAL_9_16')
assert.equal(plan.mediaJob.width, 1080)
assert.equal(plan.mediaJob.height, 1920)
assert.equal(plan.mediaJob.rights_policy, 'require_for_all_assets')
assert.equal(plan.mediaJob.procedural_soundtrack?.preset, 'cinematic')
assert.equal(plan.mediaJob.target_loudness_lufs, -14)
assert.ok(plan.analysis.removedSilenceMs > 0)
assert.ok(plan.analysis.outputDurationMs <= 15_000)
assert.match(plan.assSubtitles, /\\k35.*Фраза/)
assert.match(plan.srtSubtitles, /Фраза номер 1/)

const capabilities: FfmpegCapabilities = {
  filters: new Set(['scale', 'crop', 'concat', 'xfade', 'fps', 'setsar', 'setpts', 'sine', 'afade', 'adelay', 'amix', 'loudnorm']),
  has(name: string) { return this.filters.has(name) },
  missingRequired: [],
}
const workspace = path.resolve(process.cwd(), '.tmp-media-test')
const inputs = {
  assets: new Map(plan.mediaJob.assets.map((asset) => [asset.id, path.join(workspace, `${asset.id}.mp4`)])),
  subtitlesPath: null,
  outputPath: path.join(workspace, 'campaign-short.mp4'),
  workDirectory: workspace,
}
const ffmpegPlan = buildFfmpegArgs(plan.mediaJob, inputs, capabilities)
assert.ok(ffmpegPlan.args.includes('-ss'), 'source trim offsets must reach FFmpeg')
assert.ok(ffmpegPlan.args.includes('0.7'))
assert.match(ffmpegPlan.args[ffmpegPlan.args.indexOf('-filter_complex') + 1], /xfade=/)
assert.match(ffmpegPlan.args[ffmpegPlan.args.indexOf('-filter_complex') + 1], /loudnorm=I=-14/)

assert.equal(
  MediaIntakePayloadSchema.parse({ ...rawPayload, clips: rawPayload.clips.slice(0, 1) }).clips.length,
  1,
  'a single uploaded video must be accepted for chat montage',
)
assert.throws(
  () => MediaIntakePayloadSchema.parse({ ...rawPayload, clips: [] }),
  /upload 1 to 5 clips/,
)
assert.throws(
  () => MediaIntakePayloadSchema.parse({
    ...rawPayload,
    clips: [{ ...rawPayload.clips[0], stagedPath: `tenants/01917b12-3a5c-7d9e-bf33-9118c7e7999/uploads/foreign.mp4` }, rawPayload.clips[1], rawPayload.clips[2]],
  }),
  /another tenant/,
)
assert.throws(
  () => compileMultiClipEditPlan({
    ...rawPayload,
    clips: [{
      ...rawPayload.clips[0],
      rightsManifest: { ...rawPayload.clips[0].rightsManifest, commercialAllowed: false },
    }, rawPayload.clips[1], rawPayload.clips[2]],
  }),
  (error: unknown) => error instanceof MultiClipEditorError && error.code === 'INVALID_INTAKE',
)
assert.throws(
  () => MediaIntakePayloadSchema.parse({
    ...rawPayload,
    clips: [{
      ...rawPayload.clips[0],
      rightsManifest: {
        ...rawPayload.clips[0].rightsManifest,
        licenseType: 'cc0',
        licenseIdentifier: 'unknown-public-license',
      },
    }, rawPayload.clips[1], rawPayload.clips[2]],
  }),
  /CC0-1.0/,
)
assert.throws(
  () => MediaIntakePayloadSchema.parse({ ...rawPayload, targetRatio: '16:9' }),
  /cinematic_short requires 9:16/,
)

const bytes = new TextEncoder().encode('deterministic-render-output')
assert.equal(sha256MediaArtifact(bytes), createHash('sha256').update(bytes).digest('hex'))

console.log('Forge media intake passed: 1–5 clips, tenant paths, rights, VAD cuts, karaoke, sound design, and output integrity.')
